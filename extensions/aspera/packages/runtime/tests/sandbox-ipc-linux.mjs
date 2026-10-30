/** Built-artifact Linux regression for data-disk temporary files and private IPC. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { experimentSandboxArgv } from '../lib/experiment-sandbox.js'

for (const existing of [true, false]) test(`supports Python local-process IPC with ${existing ? 'existing' : 'new'} disk-backed temporary directories`, { skip: process.platform !== 'linux' }, () => {
  const temporaryRoot = resolve(tmpdir()), root = mkdtempSync(resolve(temporaryRoot, 'aspera-ipc-regression-'))
  try {
    const workspace = resolve(root, '.aspera', '11111111-1111-4111-8111-111111111111', 'runs', '22222222-2222-4222-8222-222222222222', 'workspace')
    mkdirSync(workspace, { recursive: true })
    if (existing) mkdirSync(resolve(workspace, 'tmp'))
    const python = 'import multiprocessing,tempfile,pathlib,json; p=tempfile.gettempdir(); print(json.dumps({"tmpdir":p,"backing":str(pathlib.Path(p).resolve())}),flush=True); m=multiprocessing.Manager(); d=m.dict(); d["probe"]=23; assert d["probe"]==23; m.shutdown(); print("MANAGER_OK",flush=True)'
    const rows = []
    for (const control of [false, true]) {
      const argv = experimentSandboxArgv({ backendPath: process.env.ASPERA_TEST_BACKEND ?? '/usr/bin/bwrap',
        workspaceRoot: workspace, devicePaths: [], hiddenPaths: [] }, ['/usr/bin/python3', '-B', '-c', python])
      if (control) argv.splice(argv.indexOf('--'), 0, '--setenv', 'TMPDIR', '/tmp')
      const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 65536 })
      rows.push({ control, status: result.status, signal: result.signal, error: result.error?.message,
        stdout: result.stdout, stderr: result.stderr?.slice(-1000) })
    }
    console.log(JSON.stringify({ workspaceBytes: Buffer.byteLength(workspace), rows }))
    for (const row of rows) {
      assert.equal(row.error, undefined); assert.equal(row.signal, null)
      assert.equal(row.status, 0, row.stderr); assert.match(row.stdout, /MANAGER_OK/)
    }
    assert.equal(JSON.parse(rows[0].stdout.split('\n')[0]).backing, resolve(workspace, 'tmp'))
  } finally {
    assert.equal(dirname(root), temporaryRoot)
    assert.ok(root.startsWith(resolve(temporaryRoot, 'aspera-ipc-regression-')))
    rmSync(root, { recursive: true, force: true })
  }
})
