import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,delimiter} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
assert.equal(process.platform,'win32','ACTUAL Windows is mandatory; do not override process.platform');
assert.equal(process.arch,'x64','This qualification targets x64 Windows');
const [bundleArg, fixtureArg, fixture86Arg, rootArg, scenario] = process.argv.slice(2);
const bundle=resolve(bundleArg), fixture=resolve(fixtureArg), fixture86=resolve(fixture86Arg), root=resolve(rootArg);
const here=dirname(fileURLToPath(import.meta.url));
const hash = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const machine=f=>{const b=readFileSync(f);assert.equal(b.toString('ascii',0,2),'MZ');const pe=b.readUInt32LE(60);assert.equal(b.readUInt32LE(pe),0x4550);return b.readUInt16LE(pe+4);};
assert.equal(machine(fixture),0x8664,'x64 control must be a compiled x64 PE');
assert.equal(machine(fixture86),0x14c,'x86 control must be a compiled x86 PE');
const placeholder=readFileSync(join(here,'fixtures/placeholder.txt'));
assert.equal(createHash('sha256').update(placeholder).digest('hex'),'6d7abae055d3b598281300a6c835086dec81bf3048f8a2294c5d3e50c8830d7b');
const prefix=join(root,scenario.startsWith('quoted-double-')?'npm;;prefix':scenario.startsWith('quoted-')?'npm;prefix':'npm prefix'), direct=join(root,'direct'), home=join(root,'home'), cwd=join(root,'cwd');
for(const path of [prefix,direct,home,cwd,join(root,'config'),join(root,'tmp')]) mkdirSync(path,{recursive:true});
// A fresh worker owns its environment. No inherited provider or owner state.
const osEnv={};
for(const key of ['SystemRoot','WINDIR','ComSpec','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS']) {
  if(process.env[key]) osEnv[key]=process.env[key];
}
for(const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env,osEnv,{HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData','Roaming'),
  LOCALAPPDATA:join(home,'AppData','Local'),TEMP:join(root,'tmp'),TMP:join(root,'tmp'),
  CLAUDEXOR_CONFIG_DIR:join(root,'config'),PATH:prefix,PATHEXT:'.COM;.EXE;.BAT;.CMD'});
process.chdir(cwd);
const packageDir=join(prefix,'node_modules','@fixture','tool'), target=join(packageDir,'bin','tool.exe');
mkdirSync(dirname(target),{recursive:true});
const repo=resolve(here,'../..');
const nativeShim=readFileSync(join(repo,'packages/core/src/fixtures/npm-launch/native.cmd'),'utf8');
const nodeShim=readFileSync(join(repo,'packages/core/src/fixtures/npm-launch/node-current.cmd'),'utf8');
const shim=join(prefix,'claude.cmd');
function installNative(bytes) {
  writeFileSync(target,bytes);
  writeFileSync(join(packageDir,'package.json'),JSON.stringify({name:'@fixture/tool',bin:{claude:'bin/tool.exe'}}));
  writeFileSync(shim,nativeShim.replace(/\r?\n/g,'\r\n'));
}
const nul=Buffer.alloc(4096), mz=Buffer.alloc(128); mz.write('MZ'); mz.writeUInt32LE(64,60);
let expectedBad=target, positive=false, recover=false, selected=target;
installNative(placeholder);
switch(scenario) {
  case 'npm-placeholder': case 'missing-path-placeholder': break;
  case 'quoted-placeholder': case 'quoted-double-placeholder': process.env.PATH='"'+prefix+'"';break;
  case 'quoted-native': case 'quoted-double-native': installNative(readFileSync(fixture));process.env.PATH='"'+prefix+'"';positive=true;break;
  case 'missing-path-native': installNative(readFileSync(fixture));positive=true;break;
  case 'placeholder-cwd-native': copyFileSync(fixture,join(cwd,'claude.exe'));break;
  case 'npm-nul': installNative(nul); break;
  case 'npm-mz-no-pe': installNative(mz); break;
  case 'direct-and-npm':
    expectedBad=join(direct,'claude.exe'); writeFileSync(expectedBad,placeholder);
    process.env.PATH=[direct,prefix].join(delimiter); break;
  case 'direct-com':
    expectedBad=join(direct,'claude.com');writeFileSync(expectedBad,placeholder);process.env.PATH=direct;break;
  case 'trailing-dot-bad': case 'trailing-dot-good':
    expectedBad=join(direct,'claude.exe');
    writeFileSync(expectedBad,scenario==='trailing-dot-good'?readFileSync(fixture):placeholder);
    selected=expectedBad;process.env.CLAUDEXOR_CLAUDE_BIN=join(direct,'claude.');positive=scenario==='trailing-dot-good';break;
  case 'explicit-exe': process.env.CLAUDEXOR_CLAUDE_BIN=target;break;
  case 'explicit-cmd': process.env.CLAUDEXOR_CLAUDE_BIN=shim;break;
  case 'explicit-relative':
    expectedBad=join(cwd,'claude.exe');writeFileSync(expectedBad,placeholder);process.env.CLAUDEXOR_CLAUDE_BIN='./claude.exe';expectedBad='claude.exe';break;
  case 'cwd-only':
    expectedBad=join(cwd,'claude.exe');writeFileSync(expectedBad,placeholder);process.env.PATH=direct;break;
  case 'native-x64': installNative(readFileSync(fixture));positive=true;break;
  case 'native-x86': installNative(readFileSync(fixture86));positive=true;break;
  case 'direct-native': case 'direct-native-com':
    selected=join(direct,scenario==='direct-native-com'?'claude.com':'claude.exe');copyFileSync(fixture,selected);process.env.PATH=direct;positive=true;break;
  case 'fallback':
    expectedBad=join(direct,'claude.exe');writeFileSync(expectedBad,placeholder);
    installNative(readFileSync(fixture));process.env.PATH=[direct,prefix].join(delimiter);positive=true;break;
  case 'repair':recover=true;break;
  case 'js': case 'bad-interpreter': {
    selected=join(packageDir,'bin','tool.cjs');
    writeFileSync(selected,`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='--version')console.log('2.1.281 (Windows qualification fixture)');else if(a[0]==='--help')console.log('--tools\\n--setting-sources\\n--strict-mcp-config\\n--permission-mode (plan, acceptEdits)\\n--disable-slash-commands\\n--no-chrome\\n--effort <level> Effort level (low, medium, high, max)');else if(a.join(' ')==='auth status')console.log(JSON.stringify({loggedIn:false,authMethod:'none'}));else process.exit(64);\n`);
    writeFileSync(join(packageDir,'package.json'),JSON.stringify({name:'@fixture/tool',bin:{claude:'bin/tool.cjs'}}));
    writeFileSync(shim,nodeShim.replace(/\r?\n/g,'\r\n'));
    expectedBad=join(prefix,'node.exe');
    if(scenario==='js'){copyFileSync(process.execPath,expectedBad);positive=true;}else writeFileSync(expectedBad,placeholder);
    break;
  }
  default:throw new Error(`Unknown scenario ${scenario}`);
}
const beforeFiles={target:hash(target),nativeX64:hash(fixture),nativeX86:hash(fixture86),node:hash(process.execPath)};
const allowed=new Set([hash(fixture),hash(fixture86),hash(process.execPath)]), calls=[],live=new Set(),results=[];
const original=Object.fromEntries(['spawn','spawnSync','exec','execFile','execSync','execFileSync','fork'].map(k=>[k,cp[k]]));
const taskkill=join(osEnv.SystemRoot,'System32','taskkill.exe');
for(const method of Object.keys(original)) cp[method]=function(binary,args,options) {
  const cleanup=String(binary).toLowerCase()===taskkill.toLowerCase();
  const record={method,binary:String(binary),args:Array.isArray(args)?args:[],cleanup};calls.push(record);
  if(cleanup) {
    const pid=Number(args?.[args.indexOf('/PID')+1]);
    assert([...live].some(child=>child.pid===pid),'cleanup may target only a still-owned live child');
    return original[method].apply(cp,arguments);
  }
  // A missed guard is an observed failure, never permission to execute a malformed image.
  let digest;try{digest=hash(binary);}catch{}
  // Only this exact suffix control permits the OS to resolve its alias. The
  // resolved fixture is still byte-allowlisted; malformed bytes never execute.
  if(!digest&&scenario==='trailing-dot-good'&&String(binary)===process.env.CLAUDEXOR_CLAUDE_BIN){
    digest=hash(selected);record.evidenceResolvedFile=selected;
  }
  if(method!=='spawn'||!allowed.has(digest)) {
    record.blocked=true;
    throw Object.assign(new Error(`EVIDENCE_BLOCKED_SPAWN ${binary}`),{code:'EVIDENCE_BLOCKED_SPAWN'});
  }
  record.sha256=digest;
  const child=original[method].apply(cp,arguments);record.pid=child.pid;
  live.add(child);child.once('close',()=>{record.closed=true;live.delete(child);});
  return child;
};
syncBuiltinESMExports();
const mod=await import(pathToFileURL(bundle).href);
const adapter=mod.createClaudeAdapter({anthropicApiKey:()=>null,claudeOAuthToken:()=>null,
  smokeIsolatedApiKey:async()=>{throw new Error('provider smoke forbidden');},
  smokeIsolatedOAuthToken:async()=>{throw new Error('provider smoke forbidden');},
});
async function observe(name,fn){
  const start=calls.length,t0=performance.now();
  try{const value=await fn();results.push({name,ok:true,value,calls:calls.length-start,ms:performance.now()-t0});return value;}
  catch(e){results.push({name,ok:false,error:String(e),code:e?.code,calls:calls.length-start,ms:performance.now()-t0});return null;}
}
async function round(label) {
  const path=process.env.PATH,bin=mod.BIN;
  const absentPath=scenario.startsWith('missing-path-');
  const patch=absentPath?{PATH:null}:{PATH:path};
  const preparedEnv={...process.env}; if(absentPath)delete preparedEnv.PATH;
  await observe(label+':resolve',()=>mod.resolveHarnessCommandOnPath(bin,path));
  await observe(label+':prepare',()=>mod.prepareHarnessCommand(bin,['--version'],preparedEnv));
  await observe(label+':version',()=>mod.detectClaudeVersion(undefined,path));
  await observe(label+':help',()=>mod.probeClaudeHelp(undefined,path));
  await observe(label+':auth',()=>mod.probeAuthStatus(bin,{env:patch}));
  await observe(label+':doctor',()=>adapter.doctor({cwd,env:{PATH:path}}));
  // Discovery normalizes PATH and may legitimately use the running Node as a later interpreter.
  // The bad-interpreter case qualifies exact PATH consumers only.
  if(scenario!=='bad-interpreter') await observe(label+':discover',()=>adapter.discover());
  await observe(label+':capture',()=>mod.runCapture(bin,['--version'],{env:patch,timeoutMs:2000}));
  await observe(label+':raw',()=>mod.runCaptureRaw(bin,['--version'],{env:patch,timeoutMs:2000}));
}
let failed;
try {
  for(let i=0;i<3;i++) await round(String(i));
  if(!positive){
    assert.equal(calls.filter(x=>!x.cleanup).length,0,'bad installation reached child_process');
    for(const r of results.filter(r=>/:version$/.test(r.name))) assert.equal(r.value,null);
    for(const r of results.filter(r=>/:doctor$/.test(r.name))) {
      assert.equal(r.value?.status,'unavailable');assert([...r.value.checks.map(c=>c.detail),...r.value.reasons].join(' ').includes(expectedBad),'doctor must identify the rejected payload');
    }
    for(const r of results.filter(r=>/:auth$/.test(r.name))) {
      assert.equal(r.value?.authed,false);assert(r.value?.probeError?.includes(expectedBad),'auth failure must identify the rejected payload');
    }
    for(const r of results.filter(r=>/:discover$/.test(r.name))) {
      assert.equal(r.ok,false);assert(r.error.includes(expectedBad),'discover must identify the rejected payload');
    }
  }
  if(recover){installNative(readFileSync(fixture));await round('repaired');positive=true;}
  if(positive){
    const chosen=results.filter(r=>/:version$/.test(r.name)).at(-1);
    assert.match(chosen.value,/2\.1\.281/,'real positive executable must run');
    const auth=results.filter(r=>/:auth$/.test(r.name)).at(-1).value;
    assert.equal(auth?.probeError,null);assert.equal(auth.authed,false);
    const help=results.filter(r=>/:help$/.test(r.name)).at(-1).value;assert.equal(help?.ok,true);assert.equal(help.code,0);
    const discovery=results.filter(r=>/:discover$/.test(r.name)).at(-1);assert.equal(discovery.ok,true);
    for(const suffix of ['capture','raw']){const r=results.filter(r=>r.name.endsWith(':'+suffix)).at(-1);assert.equal(r.value?.code,0);assert.match(r.value.stdout,/2\.1\.281/);}
    const resolution=mod.resolveHarnessCommandOnPath(mod.BIN,process.env.PATH);
    if(scenario==='trailing-dot-good') {
      assert.equal(resolution.command,null,'suffix alias is resolved by the OS fallback');
      assert(calls.some(x=>x.evidenceResolvedFile===selected&&x.pid),'real Windows suffix resolution must execute');
    } else assert.equal(realpathSync(resolution.command.entrypoint),realpathSync(selected));
    if(scenario==='fallback')assert(resolution.advisory?.includes(expectedBad));
    assert(calls.some(x=>x.pid&&x.sha256),'positive control must have a real child PID and allowed digest');
    assert.equal(calls.filter(x=>x.blocked).length,0,'unexpected or bad executable reached spawn');
    if(scenario==='native-x64'){
      const timeout=await observe('timeout',()=>mod.runCaptureRaw(mod.BIN,['--hang'],{env:{PATH:process.env.PATH},timeoutMs:200,cancelKillDelayMs:0}));
      assert(timeout===null||timeout.code!==0,'hang must not succeed');
      assert(calls.some(c=>c.args.includes('--hang')&&c.pid),'timeout control must actually launch');
      assert(results.at(-1).ms<5000,'short fixture timeout exceeded its outer bound');
      await new Promise(r=>setTimeout(r,150));assert.equal(live.size,0,'timeout left a live fixture');
    }
  }
  await new Promise(r=>setTimeout(r,100));assert.equal(live.size,0,'completed probes left live fixture children');
} catch(e){failed=e.stack??String(e);}
finally {
  const leakedBeforeCleanup=[...live].map(c=>c.pid);
  const cleanupReceipts=[];
  for(const child of live){if(child.pid){
    const receipt=original.spawnSync(taskkill,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8',timeout:5000});
    cleanupReceipts.push({pid:child.pid,status:receipt.status,stdout:receipt.stdout,stderr:receipt.stderr,error:String(receipt.error??'')});
  }}
  if(leakedBeforeCleanup.length) await new Promise(r=>setTimeout(r,200));
  const stillObservedLive=[...live].map(c=>c.pid);
  writeFileSync(join(root,'result.json'),JSON.stringify({scenario,platform:process.platform,arch:process.arch,node:process.version,fixtureMachine:{x64:machine(fixture),x86:machine(fixture86)},
    bundle:hash(bundle),beforeFiles,afterTarget:hash(target),expectedBad,selected,results,calls,leakedBeforeCleanup,cleanupReceipts,stillObservedLive,failed,pass:!failed},null,2));
}
if(failed){console.error(failed);process.exitCode=1;}
