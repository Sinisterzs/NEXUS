"""Offline regression using only the received synthetic NVIDIA H.264 fixture.
Requires FFmpeg/FFprobe on the developer PC. No GPU, capture, UI, audio or network.
"""
import hashlib,json,subprocess,unittest,statistics,tempfile,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent/'fixtures/color'
REF=json.loads((ROOT/'nvidia-4060ti-legacy.json').read_text(encoding='utf-8'))
VIDEO=ROOT/'nvidia-4060ti-legacy.h264'

class ColorPipelineRegression(unittest.TestCase):
    def test_legacy_state_and_mf_metadata_do_not_prove_limited_pixels(self):
        self.assertEqual(REF['gpuStreamColorBits'],36)
        self.assertEqual(REF['gpuOutputColorBits'],20)
        self.assertEqual(REF['mfInput']['range'],2)
        self.assertEqual(REF['mfOutput']['range'],2)
        for i,actual,limited in [(0,0,16),(4,128,126),(7,255,235)]:
            self.assertEqual(REF['patches'][i]['measuredNv12'][0],actual)
            self.assertNotEqual(actual,limited)

    def test_real_decode_of_all_24_received_colors_reproduces_range_error(self):
        self.assertEqual(hashlib.sha256(VIDEO.read_bytes()).hexdigest(),REF['videoSha256'])
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-count_frames','-show_streams','-of','json',str(VIDEO)]))['streams'][0]
        self.assertEqual(int(probe['nb_read_frames']),60)
        self.assertEqual({k:probe.get(k) for k in REF['h264Color']},REF['h264Color'])
        common=['ffmpeg','-v','error','-i',str(VIDEO),'-vf',r'select=eq(n\,30)','-frames:v','1']
        bgra=subprocess.check_output(common+['-pix_fmt','bgra','-f','rawvideo','pipe:1'])
        nv12=subprocess.check_output(common+['-pix_fmt','nv12','-f','rawvideo','pipe:1'])
        self.assertEqual(len(bgra),1280*720*4);self.assertEqual(len(nv12),1280*720*3//2)
        diffs=[]
        for p in REF['patches']:
            means=[]
            for c in range(3):
                mean=statistics.mean(bgra[(y*1280+x)*4+2-c] for y in range(p['y'],p['y']+p['height']) for x in range(p['x'],p['x']+p['width']))
                self.assertAlmostEqual(mean,p['decodedRgb'][c],delta=1.0)
                means.append(mean);diffs.append(abs(mean-p['referenceRgb'][c]))
            x=p['x']+40;y=p['y']+40;uv=1280*720+(y//2)*1280+(x//2)*2
            self.assertEqual([nv12[y*1280+x],nv12[uv],nv12[uv+1]],p['measuredNv12'])
        self.assertAlmostEqual(statistics.mean(diffs),REF['patchRgbMae'],delta=.01)
        self.assertGreater(statistics.mean(diffs),6)
        for i,gray in [(2,18),(5,204),(6,255)]:self.assertEqual(REF['patches'][i]['decodedRgb'],[gray]*3)

    def test_ab_retains_gpu_results_after_mft_failure_and_protects_existing_summary(self):
        script=Path(__file__).resolve().parents[1]/'scripts/analyze-nv12-range-comparison.py'
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for path in ['legacy','dxgi1']:
                folder=root/path;folder.mkdir()
                report={'requestedColorPath':path,'captureStarted':False,'audioStarted':False,'peerCreated':False,
                    'status':'collection_failed','error':'simulated MFT failure','gpuMax709LimitedError':.5,
                    'nv12Matches709Limited':True,'videoProcessorAfterBlt':{'path':path}}
                (folder/'reference.json').write_text(json.dumps(report),encoding='utf-8')
                (folder/'source.bgra').write_bytes(b'identical-synthetic-test-marker')
            command=[sys.executable,str(script),str(root)]
            subprocess.run(command,check=True,capture_output=True)
            output=root/'range-comparison-analysis.json';original=output.read_bytes();result=json.loads(original)
            self.assertTrue(result['sameReference'])
            for path in ['legacy','dxgi1']:
                self.assertTrue(result['paths'][path]['gpuCollection']['nv12Matches709Limited'])
                self.assertFalse(result['paths'][path]['syntheticContractPassed'])
                self.assertEqual(result['paths'][path]['gpuCollection']['gpuMax709LimitedError'],.5)
            retry=subprocess.run(command,capture_output=True)
            self.assertNotEqual(retry.returncode,0);self.assertEqual(output.read_bytes(),original)

if __name__=='__main__':unittest.main()
