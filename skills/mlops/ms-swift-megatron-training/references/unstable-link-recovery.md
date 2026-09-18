# Unstable inter-node link: NCCL deadlock detection & recovery (cross-node Megatron-SWIFT)

Verified 2026-08 on a 2-node RTX 3090 cluster (private 10.0.x.x /20, ~2ms ping, ~100Mbps egress)
where the user warned "SSH is usable but may be unstable". The link flapped repeatedly during a
tp=2 run: training deadlocked ~11 min in, and SSH to the peer dropped for minutes at a time
(exit 255 on every attempt), several times over an hour.

## The failure mode

NCCL TP collectives have no reconnect/retry for a dropped link. When the packet stream dies
mid-collective, both ranks block forever. There is no timeout (swift `ddp_timeout` only covers
init; torch NCCL op timeout defaults to 30 min but the hang is often silent).

### Hang signature (check all three)
1. Training process(es) alive on BOTH nodes, CPU ~0.3% (idle, not computing).
2. `nvidia-smi` GPU util 0% on the peer (the local GPU may still read 100% briefly / show stale
   alloc — trust the log, not the util).
3. The per-step metrics log mtime is stale: `stat -c %y train_rankX_raw.log` older than ~10 min
   while processes are alive. Last line shows a completed step, then silence.

Also: SSH to the peer starts failing (255) in the same window. The peer machine is NOT down —
`uptime` over a later SSH shows no reboot.

### Port reachability tests: "no listener" ≠ "link down" (verified pitfall)

When rank1 "can't connect" and you probe the rendezvous port from the peer, a TCP connect
failure is AMBIGUOUS: it fires both when the link is dead AND when nothing is listening on the
port. In this environment rank0 dies ~15 min after parking (rendezvous timeout, below), so by
the time you think to test `10.0.22.197:29500`, rank0 is usually already gone and the test
reports FAIL for the wrong reason — which looks like the link died again and sent you down a
false recovery path (kill/relaunch loops, firewall theories).

Correct order:
1. On rank0's node, confirm the listener exists FIRST: `ss -tlnp | grep 29500` (torchrun's
   `pt_elastic` process holds it while parked). No listener → restart rank0, then test.
2. Only with a confirmed listener, test from the peer:
   `timeout 8 bash -c 'echo > /dev/tcp/10.0.22.197/29500' && echo OK || echo FAIL`
3. A same-subnet `/dev/tcp` probe succeeding means the private link is fine — launch rank1
   immediately (rank0's 15-min rendezvous window is ticking).

### There is NO public-IP fallback for training traffic on these VMs (NAT)

These VMs carry ONLY private IPs on their interface (`ip -br addr` shows `enp3s0 10.0.22.x/20`).
The "public" IPs (36.103.199.x) belong to the NAT gateway: `10.0.22.197:29500` from the peer
fails on a dead link, and `36.103.199.132:29500` (the gateway address) fails EVEN WITH the link
up because only SSH (port 22) is port-forwarded. Do NOT plan a "fall back to public IPs for
NCCL" path — it does not exist on this topology. The private /20 is the only inter-VM path; if
it is down, distributed training is impossible until it recovers (or until you build an SSH
tunnel carrying the training ports — a real project, not a config flag).

### Why naive restarts lose everything
With the default `--save_strategy epoch`, the first checkpoint lands at epoch end (step 8,614 for
69k samples / global_batch 8). A hang at step 53 loses all 53 steps; a hang at step 5,000 loses
18 hours. Every relaunch must therefore:

```bash
--save_strategy steps --save_steps 250 \   # ~1h of work at 15s/it; adjust to link quality
--save_total_limit 3 \                     # must be >= 2 (arg validation)
--add_version false \                      # CRITICAL: reuse output_dir so resume works
```
`add_version` defaults to true and writes each launch to a fresh `v0-<ts>/` subdir — without
`false`, a restart silently starts from step 0 in a new dir and you can't resume. With
`add_version false`, the trainer loads the latest checkpoint from `output_dir` on startup.

## Recovery sequence (verified)

1. Kill BOTH ranks: `tmux kill-session -t train0` locally, same for train1 on the peer.
   Also `pkill -9 -f "[s]wift/cli/_megatron/sft"` on each node (bracket trick — see SKILL.md
   pitfall; the pattern also appears in your own cmdline).
2. Wait ~30-60s (link often recovers in minutes). Verify SSH with a patience loop, not a single try:
   ```bash
   for i in $(seq 1 20); do
     OUT=$(sshpass -p "$PW" ssh -o ConnectTimeout=15 -o ServerAliveInterval=5 ubuntu@HOST "$CMD" 2>/dev/null)
     [ $? -eq 0 ] && [ -n "$OUT" ] && { echo "$OUT"; break; }
     sleep 12
   done
   ```
3. Relaunch both rank scripts (same tmux pattern). First relaunch starts fresh (no checkpoint);
   later ones resume from the last `checkpoint-<step>`.
4. After relaunch, confirm resume actually happened: the startup log should mention loading the
   latest checkpoint / continuing from step N (not `v0-<newts>`).

## Watchdog with hang detection + auto-restart (no_agent cron)

A process-death-only watchdog misses the deadlock (procs stay alive). Add mtime staleness:
```bash
STALE_LIMIT=600   # seconds
LOCAL_MTIME=$(stat -c %Y /home/ubuntu/train_rank0_raw.log 2>/dev/null || echo 0)
NOW=$(date +%s)
# hang if processes alive AND log not touched in STALE_LIMIT
if [ "$((NOW - LOCAL_MTIME))" -gt $STALE_LIMIT ] && [ "$LOCAL_ALIVE" -ge 1 ]; then HANG=1; fi
```
Auto-restart with an anti-storm guard: refuse to restart more than once per 10 min, tracked by a
marker file (`[ -f /tmp/train_restart_ts ] && age < 600 && exit`). Restart = kill both tmux
sessions, relaunch both scripts via tmux. Schedule the cron every 5-10 min (30 min is too slow to
catch a 10-min-staleness hang promptly).

Healthy state must stay SILENT (empty stdout = no delivery in the no_agent watchdog pattern);
only emit on hang/death/disk-low.

## Cost model

Per hang you lose at most `save_steps` steps (plus save time). At save_steps 250 / 15s/it that's
~62 min worst case. If the link flaps more often than one hang per ~1h, even that stalls —
escalate to the user (link is the blocker). (Do NOT plan a public-IP NCCL fallback on these VMs —
see the NAT section above: only port 22 is forwarded through the gateway.)

## Launch order on a flaky link: park rank0 has a 15-MINUTE SHELF LIFE (verified 2026-08)

When the link is DOWN at relaunch time you may be tempted to start rank0 immediately and let it
park. It parks only ~15 minutes:

```
torch.distributed.DistStoreError: Timed out after 901 seconds waiting for clients. 1/2 clients joined.
  (from torch/distributed/elastic/rendezvous/static_tcp_rendezvous.py)
```

The STATIC TCP rendezvous (torchrun's own store) times out at 900 s regardless of swift's
`ddp_timeout` (18,000,000 ms = 5h, which only covers the process-group init AFTER rendezvous).
Observed: rank0 parked at 19:56, dead by ~20:11 with the error above. So:

- **Outage expected < ~10 min**: park rank0, auto-launch rank1 when the link returns.
- **Outage expected longer**: do NOT park. Run a patience loop until the link is back, then
  launch rank0 and rank1 back-to-back (rank0 first, rank1 within seconds). rank0's model load
  (~8 min) gives rank1 plenty of slack to join.

Also: outages can be FAR longer than the first minutes-long flaps suggest. Observed worst case:
the link was down ~85 minutes straight (three consecutive auto-launcher windows of 12, 24 and
60 min all expired before recovery on the fourth attempt). Size each window to ~30-60 min and
RE-RUN the launcher on failure — or run one long-loop daemon (300+ attempts) in the background
with `notify_on_complete`. During recovery, `scp` can succeed while the immediately-following
`ssh` in the same loop iteration fails (packet-level flapping) — the loop handles this
naturally, just don't treat a failed iteration as a bad sign.

Time-boxed runs: park time counts against the wall clock. With an 85-min outage, a "80 minutes
of training" budget is consumed before training even starts — for time-boxed runs, check the
link FIRST (patience-loop probe) and only start the clock once both ranks are up.

Background auto-launcher for rank1 (size the loop to the expected outage, e.g. 120 attempts ×
12 s ≈ 24 min, and re-run the script if it gives up — the link recovered on the second window
in practice):

```bash
#!/bin/bash
# Step 1 is scp of the CURRENT launch script — a stale copy on the peer runs the OLD config
# (e.g. epoch saves, 17k iters) and silently ignores your --train_iters change.
for i in $(seq 1 120); do
  if sshpass -p "$PW" scp -o ConnectTimeout=15 /home/ubuntu/train_rank1.sh ubuntu@HOST:/home/ubuntu/train_rank1.sh 2>/dev/null; then
    OUT=$(sshpass -p "$PW" ssh -o ConnectTimeout=15 ubuntu@HOST '
      pkill -9 -f "cli/_megatron/sft" 2>/dev/null; pkill -9 -f "torch.distributed.run" 2>/dev/null
      sleep 1; tmux kill-session -t train1 2>/dev/null
      tmux new-session -d -s train1 "bash /home/ubuntu/train_rank1.sh"; sleep 2
      echo "RANK1_LAUNCHED procs=$(pgrep -f "cli/_megatron/sft" | wc -l)"' 2>/dev/null)
    [ $? -eq 0 ] && echo "$OUT" | grep -q RANK1_LAUNCHED && { echo "launched at $(date)"; exit 0; }
  fi
  sleep 12
done
echo "GAVE_UP at $(date)"; exit 1
```

Notes:
- The pkill patterns inside the remote command use the bracket trick AND are only executed on
  the peer — the local invoking shell's cmdline contains the pattern text, so never run a local
  pkill of the same pattern in the same compound command (see SKILL.md pkill pitfall).
- Time-boxed runs: wall clock = park time + ~8 min model load + iters × s/it. Budget
  `--train_iters` from measured s/it (post-JIT, step 20+), not the first-steps speed.
