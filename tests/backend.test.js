import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/index.js';
import { createStore } from '../server/store.js';

const origin='http://localhost:3197';
const headers={Connection:'close',Host:'localhost:3197','Content-Type':'application/json','X-Studio-Request':'1',Origin:origin};
let cookie='',csrf='';
const newEntry=(status='Draft', id='test-entry')=>({id,title:'A <script>alert(1)</script> story',excerpt:'A short introduction.',body:'Saved on the server.',category:'Design',type:'Article',status,date:new Date(Date.now()+60000).toISOString(),updated:new Date().toISOString()});

test('authenticated backend, durable storage, publication, validation and session security', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-api-'));
  let app=createApplication({dbPath:join(dir,'test.sqlite'),origin,schedulerMs:20});
  await new Promise(resolve=>app.server.listen(3197,'127.0.0.1',resolve));
  const request=async(path,method='GET',data,extra={})=>{
    const response=await fetch(`http://localhost:3197${path}`,{method,headers:{...headers,Cookie:cookie,'X-CSRF-Token':csrf,...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {response,data:await response.json()};
  };
  try {
    await t.test('requires authentication and one-time owner setup', async()=>{
      assert.equal((await request('/api/workspace')).response.status,401);
      assert.equal((await request('/api/auth/status')).data.setupRequired,true);
      assert.equal((await request('/api/auth/setup','POST',{name:'Owner',email:'owner@example.com',password:'short'})).response.status,400);
      const setup=await request('/api/auth/setup','POST',{name:'Owner',email:'owner@example.com',password:'testing-password-123'});
      assert.equal(setup.response.status,200);
      cookie=setup.response.headers.get('set-cookie').split(';')[0];csrf=setup.data.csrf;
      assert.match(setup.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
      assert.equal((await request('/api/auth/setup','POST',{name:'Other',email:'other@example.com',password:'testing-password-123'})).response.status,409);
      const owner=app.store.db.prepare('SELECT password FROM owner').get();
      assert.ok(!owner.password.includes('testing-password-123'));
    });
    await t.test('blocks cross-origin writes and bad CSRF tokens',async()=>{
      const state=(await request('/api/workspace')).data;
      assert.equal((await request('/api/workspace','PUT',state,{Origin:'https://evil.example'})).response.status,403);
      assert.equal((await request('/api/workspace','PUT',state,{'X-CSRF-Token':'bad'})).response.status,403);
      assert.equal((await request('/api/workspace','PUT',state,{'X-Studio-Request':''})).response.status,403);
    });
    await t.test('persists content and rejects stale writers and forged activity',async()=>{
      const before=(await request('/api/workspace')).data;
      const result=await request('/api/workspace','PUT',{...before,entries:[newEntry()],activity:[{text:'Forged audit entry'}]});
      assert.equal(result.response.status,200);assert.equal(result.data.entries.length,1);
      assert.ok(result.data.activity.every(a=>a.text!=='Forged audit entry'));
      assert.equal((await request('/api/workspace','PUT',before)).response.status,409);
      const bad={...result.data,entries:[{...newEntry(),status:'Invalid'}]};
      assert.equal((await request('/api/workspace','PUT',bad)).response.status,400);
      assert.equal((await request('/api/workspace')).data.revision,result.data.revision);
    });
    await t.test('stores real media and rejects spoofed uploads atomically',async()=>{
      const state=(await request('/api/workspace')).data;
      const media={id:'image-1',name:'pixel.png',date:new Date().toISOString(),data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=',size:0};
      const saved=await request('/api/workspace','PUT',{...state,media:[media]});assert.equal(saved.response.status,200);assert.ok(saved.data.media[0].size>0);
      const bad=await request('/api/workspace','PUT',{...saved.data,media:[{...media,data:'data:image/png;base64,PHNjcmlwdD4='}]});assert.equal(bad.response.status,400);
      assert.equal((await request('/api/workspace')).data.media[0].data,media.data);
    });
    await t.test('publishes scheduled content without browser requests',async()=>{
      const state=(await request('/api/workspace')).data;
      const e={...state.entries[0],status:'Scheduled',date:new Date(Date.now()+150).toISOString()};
      assert.equal((await request('/api/workspace','PUT',{...state,entries:[e]})).response.status,200);
      await new Promise(resolve=>setTimeout(resolve,250));
      assert.equal(app.store.read().entries[0].status,'Published');
      const publicEntries=await request('/api/public/content','GET',undefined,{Cookie:''});assert.equal(publicEntries.data.entries.length,1);
      const page=await fetch('http://localhost:3197/site/test-entry',{headers:{Host:'localhost:3197'}});const html=await page.text();
      assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
      const state2=(await request('/api/workspace')).data;
      await request('/api/workspace','PUT',{...state2,entries:[{...state2.entries[0],status:'Draft'}]});
      assert.equal((await request('/api/public/content','GET',undefined,{Cookie:''})).data.entries.length,0);
      assert.equal((await fetch('http://localhost:3197/site/test-entry',{headers:{Host:'localhost:3197'}})).status,404);
    });
    await t.test('exports and restores backups without restoring account or session credentials',async()=>{
      const backup=(await request('/api/backup')).data;assert.ok(!('owner' in backup));assert.ok(!('sessions' in backup));
      const removed=await request('/api/workspace','PUT',{...backup,entries:[]});assert.equal(removed.data.entries.length,0);
      const restored=await request('/api/backup','PUT',{...backup,revision:removed.data.revision});assert.equal(restored.data.entries.length,1);
      const dup=await request('/api/backup','PUT',{...restored.data,entries:[restored.data.entries[0],restored.data.entries[0]]});assert.equal(dup.response.status,400);
    });
    await t.test('persists content and sessions across a complete server restart',async()=>{
      await new Promise(resolve=>app.server.close(resolve));
      app=createApplication({dbPath:join(dir,'test.sqlite'),origin,schedulerMs:20});
      await new Promise(resolve=>app.server.listen(3197,'127.0.0.1',resolve));
      const state=await request('/api/workspace');assert.equal(state.response.status,200);assert.equal(state.data.entries.length,1);assert.equal(state.data.media.length,1);
      for(const path of ['/data/studio.sqlite','/server/index.js','/.env','/package.json'])assert.equal((await request(path)).response.status,404);
    });
    await t.test('password rotation invalidates old sessions and logout revokes the new one',async()=>{
      const oldCookie=cookie;
      const changed=await request('/api/auth/password','POST',{currentPassword:'testing-password-123',password:'new-testing-password-456'});assert.equal(changed.response.status,200);
      cookie=changed.response.headers.get('set-cookie').split(';')[0];csrf=changed.data.csrf;
      assert.equal((await request('/api/workspace','GET',undefined,{Cookie:oldCookie})).response.status,401);
      assert.equal((await request('/api/auth/login','POST',{email:'owner@example.com',password:'testing-password-123'})).response.status,401);
      assert.equal((await request('/api/auth/logout','POST',{})).response.status,200);
      assert.equal((await request('/api/workspace')).response.status,401);
      const login=await request('/api/auth/login','POST',{email:'owner@example.com',password:'new-testing-password-456'});assert.equal(login.response.status,200);
    });
    await t.test('rate limits repeated login attempts',async()=>{
      let last;for(let i=0;i<16;i++)last=await request('/api/auth/login','POST',{email:'owner@example.com',password:'wrong-password'});
      assert.equal(last.response.status,429);
    });
  } finally { await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true}); }
});

test('publishing catches up after server downtime and failed transactions roll back',()=>{
  const store=createStore(':memory:');
  try {
    const backup={...store.read(),entries:[{...newEntry('Scheduled'),date:new Date(Date.now()-1000).toISOString()}]};
    store.save(backup,backup.revision,true);
    assert.equal(store.publishDue(),1);assert.equal(store.read().entries[0].status,'Published');
    const before=store.read();
    assert.throws(()=>store.save({...before,entries:[{...newEntry('Scheduled','other'),date:new Date(Date.now()-1000).toISOString()}]},before.revision),/future date/);
    assert.deepEqual(store.read(),before);
  }finally{store.close();}
});
