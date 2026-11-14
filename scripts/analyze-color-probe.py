"""Analyze synthetic probe data from AMD/NVIDIA; requires local Python and FFmpeg only.
Does not access desktop, media devices, browser, network, or Windows settings.
"""
import json,sys,subprocess,shutil
from pathlib import Path
folder=Path(sys.argv[1]).resolve()
ref=json.loads((folder/'reference.json').read_text(encoding='utf-8'))
if ref.get('status')!='collected-not-a-color-pass':raise SystemExit('Probe collection incomplete; inspect reference.json before interpreting results')
if not ref.get('syntheticOnly') or ref.get('captureStarted') or ref.get('audioStarted') or ref.get('peerCreated'):raise SystemExit('Unexpected collection provenance')
base=Path(__file__).resolve().parent
results={}
for stage,video in [('raw','encoder-raw.h264'),('final','encoded.h264')]:
 out=folder/(stage+'-analysis')
 out.mkdir(exist_ok=False)
 for name in ['reference.json','source.bgra','conversion.nv12']:shutil.copyfile(folder/name,out/name)
 shutil.copyfile(folder/video,out/'encoded.h264')
 with (out/'analysis.log').open('w',encoding='utf-8') as log:
  subprocess.run([sys.executable,str(base/'analyze-color-fidelity.py'),str(out)],stdout=log,stderr=subprocess.STDOUT,check=True)
 results[stage]=json.loads((out/'measurements.json').read_text(encoding='utf-8'))
summary={'selectedAdapter':ref.get('selectedAdapter'),'encoder':ref.get('encoder'),
 'requestedColorPath':ref.get('requestedColorPath'),
 'videoProcessorBeforeBlt':ref.get('videoProcessorBeforeBlt'),
 'videoProcessorAfterBlt':ref.get('videoProcessorAfterBlt'),
 'nv12Matches709Limited':ref.get('nv12Matches709Limited'),
 'encoderVendorMatchesRequested':ref.get('encoderVendorMatchesRequested'),
 'gpuMax709LimitedError':ref.get('gpuMax709LimitedError'),
 'displayColorMetadata':ref.get('displayColorMetadata'),
 'rawVui':results['raw']['h264Color'],'finalVui':results['final']['h264Color'],
 'rawDecodedRgb':results['raw']['scores']['decoded_auto'],
 'finalDecodedRgb':results['final']['scores']['decoded_auto'],
 'conversionInterpretations':{k:v for k,v in results['final']['scores'].items() if k.startswith('conversion_')},
 'rawCompressionLumaMae':results['raw']['compressionPatchLumaMae'],
 'finalCompressionLumaMae':results['final']['compressionPatchLumaMae'],
 'note':'Synthetic test, no HDR capture or WebView2 composition; do not treat this as visual homologation'}
(folder/'probe-analysis.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps(summary,indent=2))
