/** Exercise the shipped NVIDIA XML query with CPU subprocess fixtures, without asserting Linux GPU access. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

/** @param script - published Python query. @param parse - published inventory reader. @returns validated XML and command-failure observations. */
export function checkGpuIdentityQuery(script, parse) {
  const first = 'GPU-11111111-1111-1111-1111-111111111111'
  const second = 'GPU-22222222-2222-2222-2222-222222222222'
  const wrapper = `import subprocess,sys,types
xml,script,mode=sys.argv[1:]
def query(argv,**kwargs):
 assert argv==['nvidia-smi','-q','-x']
 assert kwargs['timeout']==5.0
 if mode=='timeout': raise subprocess.TimeoutExpired(argv,5)
 return types.SimpleNamespace(returncode=2 if mode=='error' else 0,stdout=xml,stderr='fixture NVIDIA device permission denied')
subprocess.run=query
sys.argv=['gpu-query','5']
exec(script)
`
  const run = (xml, mode = 'success') => spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', wrapper, xml, script, mode],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 })
  const xml = `<nvidia_smi_log><gpu><uuid>${second}</uuid><product_name>CPU fixture &amp; device</product_name><minor_number>5</minor_number></gpu><gpu><uuid>${first}</uuid><product_name>CPU fixture</product_name><minor_number>2</minor_number></gpu></nvidia_smi_log>`
  const result = run(xml)
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(parse(result.stdout, ['/dev/nvidia5', '/dev/nvidia2', '/dev/nvidiactl']).gpus,
    [{ uuid: first, name: 'CPU fixture', devicePath: '/dev/nvidia2' }, { uuid: second, name: 'CPU fixture & device', devicePath: '/dev/nvidia5' }])
  for (const invalid of [xml.replace('<minor_number>5</minor_number>', '<minor_number>N/A</minor_number>'), '<nvidia_smi_log/>', '<invalid']) {
    const refusal = run(invalid); assert.ifError(refusal.error); assert.notEqual(refusal.status, 0); assert.equal(refusal.stdout, '')
  }
  const failure = run(xml, 'error'); assert.ifError(failure.error); assert.notEqual(failure.status, 0)
  assert.match(failure.stderr, /fixture NVIDIA device permission denied/)
  const timeout = run(xml, 'timeout'); assert.ifError(timeout.error); assert.notEqual(timeout.status, 0); assert.match(timeout.stderr, /TimeoutExpired/)
  console.log('Published GPU query: NVIDIA XML identity/minor mapping, missing fields, malformed XML, command stderr and timeout passed with CPU fixtures; Linux GPU access is untested.')
}
