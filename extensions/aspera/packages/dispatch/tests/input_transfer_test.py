"""Execute the production input identity reader against real Linux files."""
import hashlib,json,pathlib,subprocess,sys,tempfile,unittest

source=(pathlib.Path(__file__).parents[1]/'src/input-transfer.ts').read_text()
program=source.split('const inspect = `',1)[1].split('`',1)[0]

class InputTransferCase(unittest.TestCase):
 def setUp(self):
  self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup)
  self.run=pathlib.Path(self.temporary.name);(self.run/'inputs').mkdir()
  self.owner={'version':1,'serverId':'server','experimentId':'experiment'}
  (self.run/'.aspera-owner.json').write_text(json.dumps(self.owner))
  self.request={**self.owner,'runRoot':str(self.run),'name':'package.whl','size':8,'sha256':hashlib.sha256(b'complete').hexdigest()}
 def inspect(self):
  return subprocess.run([sys.executable,'-B','-c',program],input=json.dumps(self.request),capture_output=True,text=True,timeout=10)
 def test_missing_partial_wrong_and_complete_content(self):
  for data in [None,b'part',b'changed!',b'complete']:
   with self.subTest(data=data):
    if data is not None:(self.run/'inputs/package.whl').write_bytes(data)
    result=self.inspect();self.assertEqual(result.returncode,0,result.stderr)
    self.assertEqual(json.loads(result.stdout)['complete'],data==b'complete')
 def test_foreign_owner_and_links_are_refused(self):
  (self.run/'source').write_bytes(b'complete')
  (self.run/'inputs/package.whl').symlink_to(self.run/'source')
  self.assertNotEqual(self.inspect().returncode,0)
  (self.run/'inputs/package.whl').unlink()
  import os
  os.link(self.run/'source',self.run/'inputs/package.whl')
  self.assertNotEqual(self.inspect().returncode,0)
  self.request['experimentId']='another'
  self.assertIn('Input owner differs',self.inspect().stderr)
 def test_input_path_cannot_escape(self):
  self.request['name']='../source'
  self.assertIn('escaped',self.inspect().stderr)

if __name__=='__main__':unittest.main()
