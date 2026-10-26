// External watchdog: a blocked worker cannot block its own timeout.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync,readdirSync,openSync,writeSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
assert.equal(process.platform,'win32','Run on an actual Windows host');
const [outArg='.review-evidence/windows-qualification/out',...selection]=process.argv.slice(2);
const out=resolve(outArg),here=dirname(fileURLToPath(import.meta.url));
const cases=selection.length?selection:['npm-placeholder','npm-nul','npm-mz-no-pe','direct-and-npm','direct-com',
  'explicit-exe','explicit-cmd','explicit-relative','cwd-only','bad-interpreter','native-x64','native-x86','direct-native','direct-native-com','js','fallback','repair','quoted-placeholder','quoted-native','missing-path-placeholder','missing-path-native','placeholder-cwd-native','quoted-double-placeholder','quoted-double-native'];
const rows=[];
const scratch=mkdtempSync(join(tmpdir(),'cx-win-qualification-'));
const bundle=join(out,'candidate.mjs'),fixture=join(out,'fixture-x64.exe'),fixture86=join(out,'fixture-x86.exe');
const hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
const identity=JSON.parse(readFileSync(join(out,'build-identity.json'),'utf8'));
assert.equal(hash(bundle),identity.bundle,'bundle changed since build-identity was captured');
try {
  for(const scenario of cases){
    assert(/^[a-z0-9-]+$/.test(scenario));
    const root=join(scratch,scenario),dest=join(out,scenario);mkdirSync(root);mkdirSync(dest,{recursive:true});
    const child=spawn(process.execPath,[join(here,'worker.mjs'),bundle,fixture,fixture86,root,scenario],
      {stdio:['ignore','pipe','pipe'],windowsHide:true});
    let timedOut=false,closed=false,kill;
    const stdoutFd=openSync(join(dest,'stdout.log'),'wx'),stderrFd=openSync(join(dest,'stderr.log'),'wx');
    child.stdout.on('data',b=>writeSync(stdoutFd,b));
    child.stderr.on('data',b=>writeSync(stderrFd,b));
    const timer=setTimeout(()=>{
      timedOut=true;
      if(!closed&&child.pid){
        kill=spawnSync(join(process.env.SystemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8',timeout:5000});
        child.kill(); // pinned ChildProcess fallback; no image-name/global kill
      }
    },45000);
    const exit=await new Promise(resolveExit=>{
      child.once('error',e=>resolveExit({error:String(e)}));
      child.once('close',(code,signal)=>{closed=true;resolveExit({code,signal});});
    });
    clearTimeout(timer);
    let result;try{copyFileSync(join(root,'result.json'),join(dest,'result.json'));result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));}catch{}
    closeSync(stdoutFd);closeSync(stderrFd);
    const row={scenario,...exit,timedOut,kill:kill&&{status:kill.status,stdout:kill.stdout,stderr:kill.stderr,error:String(kill.error??'')},
      pass:exit.code===0&&!timedOut&&result?.pass===true};
    rows.push(row);console.log(JSON.stringify(row));
  }
} finally {
  writeFileSync(join(out,'summary.json'),JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,
    bundle:hash(bundle),nativeX64:hash(fixture),nativeX86:hash(fixture86),worker:hash(join(here,'worker.mjs')),
    requestedCases:cases,rows,pass:rows.length===cases.length&&rows.every(x=>x.pass)},null,2));
  try{rmSync(scratch,{recursive:true,force:true});}catch(e){writeFileSync(join(out,'cleanup-error.txt'),String(e));process.exitCode=1;}
  const files=[];
  function walk(dir){for(const ent of readdirSync(dir,{withFileTypes:true})){const p=join(dir,ent.name);if(ent.isDirectory())walk(p);else if(ent.name!=='MANIFEST.sha256')files.push(p);}}
  walk(out);writeFileSync(join(out,'MANIFEST.sha256'),files.sort().map(f=>`${hash(f)}  ${f.slice(out.length+1)}`).join('\n')+'\n');
}
if(rows.length!==cases.length||rows.some(x=>!x.pass))process.exitCode=1;
