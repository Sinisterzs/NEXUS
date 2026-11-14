import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const directory=path.resolve('node_modules/.cache/diagnostics-tests');fs.mkdirSync(directory,{recursive:true});
await build({entryPoints:['tests/diagnostics_service.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},outfile:path.join(directory,'service.mjs')});
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',path.join(directory,'service.mjs')],{stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;

await build({entryPoints:['tests/synthetic_peer_diagnostics.test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',define:{'import.meta.env':'{}'},outfile:path.join(directory,'peer.mjs')});
const peer=spawnSync(process.execPath,['--test','--test-concurrency=1',path.join(directory,'peer.mjs')],{stdio:'inherit',windowsHide:true});
if(peer.status!==0)process.exitCode=peer.status??1;
