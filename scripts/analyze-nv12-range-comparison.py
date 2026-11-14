"""Developer-side analysis of portable synthetic legacy/dxgi1 A/B collection.
Requires FFmpeg locally; never captures media or changes settings.
"""
import hashlib,json,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]).resolve();summary_path=root/'range-comparison-analysis.json'
if summary_path.exists() or any((root/p/(s+'-analysis')).exists() for p in ['legacy','dxgi1'] for s in ['raw','final']):
    raise SystemExit('Analysis already exists; extract a fresh copy. Existing reports preserved.')
results={};sources={}
for path in ['legacy','dxgi1']:
    folder=root/path
    try:
        ref=json.loads((folder/'reference.json').read_text(encoding='utf-8'))
        if ref.get('requestedColorPath')!=path or ref.get('captureStarted') or ref.get('audioStarted') or ref.get('peerCreated'):
            raise ValueError('Unexpected A/B provenance')
        entry={'collectionStatus':ref.get('status'),'error':ref.get('error'),'syntheticContractPassed':False,
            'gpuCollection':{k:ref.get(k) for k in ['videoProcessorBeforeBlt','videoProcessorAfterBlt','gpuMax709LimitedError','gpuPatchMeasurements','nv12Matches709Limited','mfInput','mfOutput']}}
        results[path]=entry
        if (folder/'source.bgra').exists():sources[path]=hashlib.sha256((folder/'source.bgra').read_bytes()).hexdigest()
        if ref.get('status')!='collected-not-a-color-pass':continue
        with (folder/'analysis.log').open('x',encoding='utf-8') as log:
            subprocess.run([sys.executable,str(Path(__file__).with_name('analyze-color-probe.py')),str(folder)],stdout=log,stderr=subprocess.STDOUT,check=True)
        analysis=json.loads((folder/'probe-analysis.json').read_text(encoding='utf-8'))
        decoded=json.loads((folder/'final-analysis/measurements.json').read_text(encoding='utf-8'))
        passed=(ref.get('nv12Matches709Limited') is True and ref.get('encoderVendorMatchesRequested') is True
            and decoded['decodedFrameCount']==60 and analysis['finalDecodedRgb']['patchMeanAbsoluteRgbError']<=3
            and analysis['finalDecodedRgb']['patchMaxMeanChannelError']<=5
            and analysis['finalVui']=={'color_range':'tv','color_space':'bt709','color_transfer':'bt709','color_primaries':'bt709'})
        entry.update({'syntheticContractPassed':passed,'analysis':analysis,'decodedFrames':decoded['decodedFrameCount']})
    except (OSError,ValueError,KeyError,subprocess.SubprocessError) as exc:
        results.setdefault(path,{}).update({'error':str(exc),'syntheticContractPassed':False})
summary={'paths':results,'sameReference':len(sources)==2 and len(set(sources.values()))==1,
    'limits':'Synthetic hardware encode/decode comparison only. Not real DXGI/WGC, WAN, preview/canvas or full NEXUS homologation. No NVIDIA pass inferred from AMD.'}
summary_path.write_text(json.dumps(summary,indent=2),encoding='utf-8')
print(json.dumps(summary,indent=2))
