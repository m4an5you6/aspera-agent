/** NVIDIA XML queries shared by local controller checks and SSH preparation. */

/** Python query requiring a timeout in seconds as its first argument; emits UUID, name and device minor from NVIDIA XML. */
export const gpuIdentityQueryScript = `import re,subprocess,sys,xml.etree.ElementTree as ET
result=subprocess.run(['nvidia-smi','-q','-x'],capture_output=True,text=True,timeout=float(sys.argv[1]))
if result.returncode!=0: raise RuntimeError('NVIDIA query exited '+str(result.returncode)+': '+result.stderr.strip())
root=ET.fromstring(result.stdout)
rows=[]
for gpu in root.findall('gpu'):
 uuid=(gpu.findtext('uuid') or '').strip()
 name=(gpu.findtext('product_name') or '').strip()
 minor=(gpu.findtext('minor_number') or '').strip()
 if not uuid or not name or '\\n' in name or '\\r' in name or not re.fullmatch('[0-9]+',minor): raise RuntimeError('NVIDIA XML lacks a GPU identity or Linux device minor')
 rows.append(uuid+', '+name+', '+minor)
if not rows: raise RuntimeError('NVIDIA XML contains no GPUs')
print('\\n'.join(rows))
`
