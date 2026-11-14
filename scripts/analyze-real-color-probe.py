"""Offline analysis on the developer PC; the transmitter needs no Python/FFmpeg.
Usage: python scripts/analyze-real-color-probe.py EXTRACTED_REAL_RESULT_DIRECTORY
Keeps DXGI and WGC independent. Never declares a cause or a visual pass automatically.
"""
import json, shutil, subprocess, sys, statistics
from pathlib import Path

def patch_means(data, patches, width=1280, height=720):
    if len(data) != width*height*4:
        raise ValueError('Unexpected BGRA buffer size')
    result=[]
    for p in patches:
        sums=[0,0,0]
        for y in range(p['y'],p['y']+p['height']):
            for x in range(p['x'],p['x']+p['width']):
                offset=(y*width+x)*4
                for c in range(3): sums[c]+=data[offset+2-c]
        result.append([s/(p['width']*p['height']) for s in sums])
    return result

def error(a,b):
    differences=[abs(x-y) for row,ref in zip(a,b) for x,y in zip(row,ref)]
    return {'patchMeanAbsoluteRgbError':round(statistics.mean(differences),4),
            'patchMaxMeanChannelError':round(max(differences),4)}

def main(root=None):
    root=Path(root if root is not None else sys.argv[1]).resolve(); script=Path(__file__).with_name('analyze-color-fidelity.py')
    if (root/'real-color-analysis.json').exists() or any((root/b/(s+'-analysis')).exists() for b in ['dxgi','wgc'] for s in ['raw','final']):
        raise FileExistsError('Analysis already exists; use a freshly extracted result directory. Existing reports were preserved.')
    summary={}
    for backend in ['dxgi','wgc']:
        folder=root/backend
        if not (folder/'reference.json').exists():
            summary[backend]={'status':'missing-report'};continue
        ref=json.loads((folder/'reference.json').read_text(encoding='utf-8'))
        if not (folder/'captured.bgra').exists():
            summary[backend]={'status':ref.get('status'),'error':ref.get('error')};continue
        capture=ref.get('realCapture',{})
        if not ref.get('syntheticOnly') or not ref.get('captureStarted') or ref.get('audioStarted') or ref.get('peerCreated') or capture.get('backendActual')!=backend or capture.get('fallback') is not False:
            raise ValueError('Unexpected capture provenance')
        patches=ref['patches']; expected=[p['rgb'] for p in patches]
        captured=patch_means((folder/'captured.bgra').read_bytes(),patches)
        preview=None
        if (folder/'preview.bgra').exists():
            scaled=[{**p,**{k:p[k]//2 for k in ['x','y','width','height']}} for p in patches]
            preview_means=patch_means((folder/'preview.bgra').read_bytes(),scaled,640,360)
            preview={'referenceToPreviewRgb':error(preview_means,expected),'capturedToPreviewRgb':error(preview_means,captured),'patchRgb':preview_means,'canvasMeasured':False}
        stages={}
        # Persist usable early stages even when MFT/decode fails later.
        entry={'status':'partial-measurements-not-homologated','collectionStatus':ref.get('status'),
            'collectionError':ref.get('error'),'adapter':ref.get('selectedAdapter'),
            'encoder':ref.get('encoder'),'encoderVendorMatchesRequested':ref.get('encoderVendorMatchesRequested'),
            'realCapture':capture,'referenceToCapturedRgb':error(captured,expected),
            'capturedPatchRgb':captured,'previewGpu':preview,'stages':stages}
        summary[backend]=entry
        if (folder/'conversion.nv12').exists():
            nv12=(folder/'conversion.nv12').read_bytes();converted=[];yuv=[]
            if len(nv12)!=1280*720*3//2:
                entry['nv12Error']='Unexpected NV12 size'
            else:
                # Interior samples are uniform in the validated chart. This analytic
                # inverse is available even without FFmpeg/MFT; full decode below is separate.
                for p in patches:
                    x=p['x']+p['width']//2;y=p['y']+p['height']//2;uv=1280*720+(y//2)*1280+(x//2)*2
                    yy,u,v=nv12[y*1280+x],nv12[uv],nv12[uv+1];yuv.append([yy,u,v])
                    l=(yy-16)/219;cb=(u-128)/224;cr=(v-128)/224
                    r=l+1.5748*cr;b=l+1.8556*cb;g=(l-.2126*r-.0722*b)/.7152
                    converted.append([max(0,min(255,c*255)) for c in [r,g,b]])
                entry['capturedToNv12CenterAnalyticRgb']=error(converted,captured)
                entry['nv12CenterYuv']=yuv
        for stage,video in [('raw','encoder-raw.h264'),('final','encoded.h264')]:
          try:
            out=folder/(stage+'-analysis');out.mkdir(exist_ok=False)
            for name in ['reference.json','source.bgra','conversion.nv12']:shutil.copyfile(folder/name,out/name)
            shutil.copyfile(folder/video,out/'encoded.h264')
            with (out/'analysis.log').open('w',encoding='utf-8') as log:
                subprocess.run([sys.executable,str(script),str(out)],stdout=log,stderr=subprocess.STDOUT,check=True)
            result=json.loads((out/'measurements.json').read_text(encoding='utf-8'))
            decoded=[p['stages']['decoded_auto'] for p in result['patches']]
            converted=[p['stages']['conversion_bt709_tv'] for p in result['patches']]
            stages[stage]={'h264Color':result['h264Color'],'decodedFrameCount':result['decodedFrameCount'],
                'capturedToNv12RoundtripRgb':error(converted,captured),
                'capturedToDecodedRgb':error(decoded,captured),'referenceToDecodedRgb':error(decoded,expected),
                'compressionLumaMae':result['compressionPatchLumaMae'],'compressionChromaMae':result['compressionPatchChromaMae'],
                'patches':[{'index':p['index'],'referenceRgb':p['rgb'],'capturedRgb':captured[i],
                    'nv12Yuv':result['patches'][i]['yuv'],'nv12RoundtripRgb':converted[i],'decodedRgb':decoded[i]}
                    for i,p in enumerate(patches)]}
          except (OSError,ValueError,KeyError,subprocess.SubprocessError) as exc:
            stages[stage]={'status':'analysis-failed','error':str(exc)}
        if all('decodedFrameCount' in stages[s] for s in ['raw','final']):entry['status']='measured-not-homologated'
    summary['limits']='One fresh real capture per backend, replayed through 60 encoder inputs. Not capture FPS, WAN, HDR/ICC diagnosis, IPC/canvas or WebView2 presentation validation. Interpret stage deltas before any correction.'
    (root/'real-color-analysis.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps({k:({a:b for a,b in v.items() if a!='stages'} if isinstance(v,dict) else v) for k,v in summary.items()},indent=2))

if __name__=='__main__':
    if sys.argv[1:] == ['--self-test']:
        p=[{'x':0,'y':0,'width':2,'height':2}]
        assert patch_means(bytes([30,20,10,255])*4,p,2,2)==[[10,20,30]]
        assert error([[10,20,30]],[[10,20,30]])['patchMeanAbsoluteRgbError']==0
        assert error([[18,28,38]],[[10,20,30]])['patchMeanAbsoluteRgbError']==8
        try:patch_means(b'',p,2,2)
        except ValueError:pass
        else:raise AssertionError('Invalid buffer accepted')
        import tempfile, contextlib, io
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for backend in ['dxgi','wgc']:
                folder=root/backend;folder.mkdir()
                ref={'status':'collection_failed' if backend=='dxgi' else 'collected-not-a-color-pass',
                     'error':'simulated MFT failure' if backend=='dxgi' else None,
                     'syntheticOnly':True,'captureStarted':True,'audioStarted':False,'peerCreated':False,
                     'realCapture':{'backendActual':backend,'fallback':False},
                     'patches':[{'index':0,'x':0,'y':0,'width':2,'height':2,'rgb':[10,20,30]}]}
                (folder/'reference.json').write_text(json.dumps(ref),encoding='utf-8')
                (folder/'captured.bgra').write_bytes(bytes([30,20,10,255])*(1280*720))
                if backend=='wgc':
                    (folder/'source.bgra').write_bytes(bytes([30,20,10,255])*(1280*720))
                    (folder/'conversion.nv12').write_bytes(bytes([128])*(1280*720*3//2))
                    for name in ['encoder-raw.h264','encoded.h264']:(folder/name).write_bytes(b'simulated-invalid-stream')
            with patch('subprocess.run',side_effect=subprocess.CalledProcessError(1,'ffmpeg-simulated')),contextlib.redirect_stdout(io.StringIO()):
                main(root)
            result=json.loads((root/'real-color-analysis.json').read_text(encoding='utf-8'))
            assert result['dxgi']['referenceToCapturedRgb']['patchMeanAbsoluteRgbError']==0
            assert result['wgc']['referenceToCapturedRgb']['patchMeanAbsoluteRgbError']==0
            assert result['wgc']['stages']['raw']['status']=='analysis-failed'
            assert result['wgc']['stages']['final']['status']=='analysis-failed'
            assert 'capturedToNv12CenterAnalyticRgb' in result['wgc']
            previous=(root/'real-color-analysis.json').read_bytes()
            try:main(root)
            except FileExistsError:pass
            else:raise AssertionError('Existing analysis was not protected')
            assert (root/'real-color-analysis.json').read_bytes()==previous
        print('PASS: BGRA, patch averages, stage deltas, truncated buffers, MFT partial results, independent decode/backend failures, existing-report preservation')
    else:main()
