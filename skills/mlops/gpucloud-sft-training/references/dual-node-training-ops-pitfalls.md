# Dual-node Megatron-SWIFT training: runtime ops pitfalls (verified 2026-08)

TP=2 cross-node (2x RTX 3090, flaky public SSH, private 10.0.22.x
interconnect, ~2ms). All symptoms + fixes verified in-session.

## Disk fills up and silently kills training (the big one)

Symptom: training dies exactly at a save step; rank0 log ends
`TRAIN_RANK0_EXIT=1` with no traceback; remote rank1 shows NCCL watchdog
`ncclRemoteError: Connection closed by remote peer` + SIGABRT (exitcode -6).

Root cause: `--merge_lora true` (DEFAULT) with a Qwen bridge that lacks
`_support_hf_grouped_lora` makes swift SKIP saving the LoRA adapter and
instead write a FULL merged model every `save_steps`
(`checkpoint-N-merged`, ~18GB for a 9B model). `_rotate_checkpoints` only
rotates `checkpoint-N`, NEVER `*-merged`, so disk grows unboundedly:
4 saves = 56GB -> disk 100% -> checkpoint write fails -> rank0 exits ->
remote NCCL sees the peer die and aborts. This is why a job that ran fine
for 100+ iters suddenly dies at the 4th-5th save.

Fixes:
- Train with `--merge_lora false` — checkpoints shrink to ~43MB adapter
  (merge once after training via `megatron export`).
- Watchdog disk guard: if `df /` > 90%, `rm -rf output/*/checkpoint-*-merged`
  before any restart.

## rank1 dies instantly with EXIT=247

Symptom: remote rank1 exits within seconds with EXIT=247; its raw log contains
only the `run sh:` line, no traceback, no NCCL output.

Root cause: rank1 launched BEFORE rank0's torchrun rendezvous port is
listening (`ss -tln | grep :29500`, process `pt_elastic`). rank0 takes
minutes to load an 18GB model on cold cache, so a "simultaneous" launch
fails.

Fix: start rank0 -> poll `ss -tln` for `:29500` -> ONLY then start rank1.
Watchdog must encode this wait (up to ~15 min).

## rank0 dies on SSH drop (SIGHUP)

Wrap BOTH ranks in tmux: `tmux new-session -d -s train0 "bash body.sh"`.
Without it, an SSH disconnect sends SIGHUP (log ends `SignalException ...
got signal: 1`) and the whole job dies even though the remote is fine.

## No auto-resume in swift megatron SFT

`finetune=True` (default) => `_load_checkpoint` does NOT restore iteration;
restart always begins at iteration 0. There is NO `--resume_from_checkpoint`.
So checkpoint frequency IS the resilience: for 280 iters use
`--save_steps 28` (10 saves) + `--save_total_limit 3`, not a sparse
`--save_steps 250` that loses everything on the first interruption.

## Watchdog pattern (flaky-link friendly, no ping)

crontab every 5 min, single script:
- completion check: `checkpoint-<final>` exists -> exit 0 (self-disable).
- disk guard (>90% -> rm `*-merged`).
- rank0 alive: `pgrep -f '[c]li/_megatron/sft'` (bracket trick).
- staleness: raw log mtime > 600s -> treat as hung.
- anti-flap: min 240s between restarts (state file).
- restart: kill both ranks -> relaunch rank0 -> WAIT for port 29500 ->
  relaunch rank1 with retries.
- probe remote reachability with `ssh true`, NEVER ping/ICMP (user rule).

## pkill self-match trap

`pkill -f "auto_rank1"` inside a shell whose own command line ALSO contains
"auto_rank1" (e.g. a later `tmux new-session ... auto_rank1.sh` argument in
the same command) kills the invoking shell itself (exit -9, silent). Always
use the bracket trick: `pkill -9 -f "[a]uto_rank1"`, `[c]li/_megatron/sft`,
`[t]orch.distributed.run`.

## Also seen

- Remote machine's public IP is a NAT gateway address and CHANGES (e.g.
  .245 -> .200 while the private 10.0.22.140 stayed). Scripts that hardcode
  the public IP (scp/ssh helpers) break; probe it, or better: run all
  cross-node traffic over the private 10.0.22.x which is stable.
- Host-key change on reconnect: `ssh-keygen -R <ip>` once, then reconnect.
- The remote non-master checkpoint dir lacks the tracker/metadata files
  (master-only) — see gpucloud-megatron-weight-export reference.
