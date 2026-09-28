import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../automation/V2Automation.gs',import.meta.url),'utf8');

test('canonical token takes priority over a stale duplicate without exposing either',()=>{
  const props={TV2_SYNC_URL:'https://script.google.com/macros/s/example/exec',TV2_SYNC_TOKEN:'stale-stale-stale-stale-stale',TV_V2_SYNC_TOKEN:'canonical-canonical-canonical-canonical'};
  const context=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:key=>props[key]})}});
  vm.runInContext(source,context);
  assert.equal(vm.runInContext('tv2Config_().tokens[0]',context),props.TV_V2_SYNC_TOKEN);
  delete props.TV_V2_SYNC_TOKEN;
  assert.equal(vm.runInContext('tv2Config_().tokens[0]',context),props.TV2_SYNC_TOKEN);
});

test('tries the second configured token only after authentication rejection',()=>{
  const props={TV2_SYNC_URL:'https://script.google.com/macros/s/example/exec',TV2_SYNC_TOKEN:'alternate-alternate-alternate',TV_V2_SYNC_TOKEN:'canonical-canonical-canonical'};
  const attempts=[];
  const context=vm.createContext({
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>props[key]})},
    UrlFetchApp:{fetch:(_url,options)=>{const token=JSON.parse(options.payload).token;attempts.push(token);return{getContentText:()=>JSON.stringify(token===props.TV2_SYNC_TOKEN?{ok:true,payload:{schemaVersion:2}}:{ok:false,error:'認証に失敗しました'})}}}
  });
  vm.runInContext(source,context);
  assert.equal(vm.runInContext("tv2Call_({action:'load'}).ok",context),true);
  assert.deepEqual(attempts,[props.TV_V2_SYNC_TOKEN,props.TV2_SYNC_TOKEN]);
});

test('does not retry a non-authentication API error',()=>{
  const props={TV2_SYNC_URL:'https://script.google.com/macros/s/example/exec',TV2_SYNC_TOKEN:'alternate-alternate-alternate',TV_V2_SYNC_TOKEN:'canonical-canonical-canonical'};
  let attempts=0;
  const context=vm.createContext({
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>props[key]})},
    UrlFetchApp:{fetch:()=>{attempts++;return{getContentText:()=>JSON.stringify({ok:false,error:'revision conflict'})}}}
  });
  vm.runInContext(source,context);
  assert.throws(()=>vm.runInContext("tv2Call_({action:'load'})",context),/revision conflict/);
  assert.equal(attempts,1);
});

test('installer creates one recurring trigger plus one self-removing bootstrap',()=>{
  assert.match(source,/newTrigger\(handler\)\.timeBased\(\)\.everyMinutes\(15\)\.create\(\)/);
  assert.match(source,/newTrigger\('runTv2AutomationBootstrap_'\)\.timeBased\(\)\.after\(15000\)\.create\(\)/);
  assert.match(source,/function tv2AutomationStatus\(\)/);
  assert.match(source,/function runTv2AutomationBootstrap_\(\)/);
});
