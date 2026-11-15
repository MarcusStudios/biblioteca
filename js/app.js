const $=id=>document.getElementById(id);
let books=[],logs=[],col=null,logsCol=null,photo='',lookupSeq=0,pendingMeta={},openBookId='',editMode=false,editPhoto='',currentUser='';
let filt='all';
const COLORS=['#5a3a22','#3f4f2f','#4a3a2a','#2f4046','#6b4a2a','#46402f','#503a30'];
let view='list';try{view=localStorage.getItem('biblioteca_view')||'list'}catch(e){}
function toggleView(){view=view==='grid'?'list':'grid';try{localStorage.setItem('biblioteca_view',view)}catch(e){}render()}
function createLocalCol(key){
  let onSnap=null;
  const load=()=>{try{return JSON.parse(localStorage.getItem(key)||'[]')}catch(e){return []}};
  const persist=arr=>{localStorage.setItem(key,JSON.stringify(arr));emit(arr)};
  const emit=arr=>{
    if(!onSnap)return;
    const sorted=[...arr].sort((a,b)=>(b.criado||0)-(a.criado||0));
    onSnap({docs:sorted.map(x=>({id:x.id,data:()=>x}))});
  };
  return {
    orderBy(){return {onSnapshot(cb){onSnap=cb;emit(load())}}},
    doc(id){
      return {
        async set(data){const arr=load().filter(x=>x.id!==id);arr.push({id,...data});persist(arr)},
        async update(patch){const arr=load().map(x=>x.id===id?{...x,...patch}:x);persist(arr)},
        async delete(){persist(load().filter(x=>x.id!==id))}
      };
    }
  };
}
let idbPromise=null;
function openIdb(){
  return idbPromise||(idbPromise=new Promise((res,rej)=>{
    const req=indexedDB.open('BibliotecaConventoDB',2);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('livros'))db.createObjectStore('livros',{keyPath:'id'});
      if(!db.objectStoreNames.contains('logs'))db.createObjectStore('logs',{keyPath:'id'});
    };
    req.onsuccess=()=>res(req.result);
    req.onerror=()=>rej(req.error);
  }));
}
function createIdbCol(storeName,legacyKey){
  let onSnap=null;
  const tx=async(mode,fn)=>{
    const db=await openIdb();
    return new Promise((res,rej)=>{
      const t=db.transaction(storeName,mode),st=t.objectStore(storeName),r=fn(st);
      t.oncomplete=()=>res(r&&r.result!==undefined?r.result:undefined);
      t.onerror=()=>rej(t.error);
    });
  };
  const all=()=>tx('readonly',st=>st.getAll());
  const emit=async()=>{
    if(!onSnap)return;
    const arr=(await all())||[];
    arr.sort((a,b)=>(b.criado||0)-(a.criado||0));
    onSnap({docs:arr.map(x=>({id:x.id,data:()=>x}))});
  };
  const migrate=async()=>{
    try{
      if(!legacyKey)return;
      const cur=await all();
      if(cur&&cur.length)return;
      const raw=localStorage.getItem(legacyKey);
      if(!raw)return;
      const arr=JSON.parse(raw);
      if(Array.isArray(arr)&&arr.length)await tx('readwrite',st=>arr.forEach(x=>x&&x.id&&st.put(x)));
    }catch(e){}
  };
  return {
    orderBy(){return {onSnapshot(cb){onSnap=cb;migrate().then(emit).catch(()=>{})}}},
    doc(id){
      return {
        async set(data){await tx('readwrite',st=>st.put({id,...data}));await emit()},
        async update(patch){const cur=await tx('readonly',st=>st.get(id));if(cur){await tx('readwrite',st=>st.put({...cur,...patch,id}));await emit()}},
        async delete(){await tx('readwrite',st=>st.delete(id));await emit()}
      };
    }
  };
}
let supaLastSync=0,supaTimer=null,supaSyncing=false;
function getSupaCfg(){
  try{
    const cu=getAppKey('SUPABASE_URL'),ck=getAppKey('SUPABASE_KEY');if(cu&&ck)return {url:cu.replace(/\/+$/,''),key:ck};
    const raw=localStorage.getItem('biblioteca_supabase');
    if(!raw)return null;
    const p=JSON.parse(raw);
    return p&&p.url&&p.key?{url:String(p.url).replace(/\/+$/,''),key:String(p.key).trim()}:null;
  }catch(e){return null}
}
async function supaReq(path,opts={}){
  const cfg=getSupaCfg();
  if(!cfg)return null;
  const res=await fetch(cfg.url+'/rest/v1/'+path,{...opts,headers:{apikey:cfg.key,Authorization:'Bearer '+cfg.key,'Content-Type':'application/json',...(opts.headers||{})}});
  if(!res.ok)throw new Error('Supabase HTTP '+res.status);
  const txt=await res.text();
  return txt?JSON.parse(txt):null;
}
function createSupaCol(table,baseCol){
  let localItems=[];
  const upsertRemote=(id,doc)=>supaReq(table+'?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id,data:doc,updated_at:Date.now()})}).catch(()=>{});
  const deleteRemote=(id)=>supaReq(table+'?id=eq.'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{});
  return {
    orderBy(f,d){
      const q=baseCol.orderBy(f,d);
      return {
        onSnapshot(cb){
          q.onSnapshot(sn=>{
            localItems=sn.docs.map(x=>({id:x.id,...x.data()}));
            cb(sn);
          });
        }
      };
    },
    doc(id){
      const bDoc=baseCol.doc(id);
      return {
        async set(data){await bDoc.set(data);upsertRemote(id,{id,...data})},
        async update(patch){
          await bDoc.update(patch);
          const cur=localItems.find(x=>x.id===id);
          if(cur)upsertRemote(id,{...cur,...patch,id});
        },
        async delete(){await bDoc.delete();deleteRemote(id)}
      };
    },
    async pull(){
      const rows=await supaReq(table+'?select=id,data,updated_at');
      if(!Array.isArray(rows))return;
      const remoteIds=new Set();
      for(const r of rows){
        if(!r||!r.id||!r.data)continue;
        remoteIds.add(r.id);
        await baseCol.doc(r.id).set(r.data);
      }
      for(const loc of localItems){
        if(loc&&loc.id&&!remoteIds.has(loc.id))await upsertRemote(loc.id,loc);
      }
    }
  };
}
async function syncNow(silent=false){
  const cfg=getSupaCfg();
  if(!cfg||supaSyncing)return;
  supaSyncing=true;
  try{
    if(col&&col.pull)await col.pull();
    if(logsCol&&logsCol.pull)await logsCol.pull();
    supaLastSync=Date.now();
    if(!silent)toast('Sincronizado com Supabase ✔');
    if($('p4')&&!$('p4').hidden)renderProfile();
  }catch(e){
    if(!silent)toast('Erro ao sincronizar com Supabase');
  }finally{supaSyncing=false}
}
async function saveSupabaseCfg(){
  const url=($('sbUrlInput')&&$('sbUrlInput').value||'').trim().replace(/\/+$/,'');
  const key=($('sbKeyInput')&&$('sbKeyInput').value||'').trim();
  if(!url||!key){say('sbStatus','Informe a URL e a Anon Key do Supabase.','warn');return}
  try{localStorage.setItem('biblioteca_supabase',JSON.stringify({url,key}))}catch(e){}
  say('sbStatus','Conectando ao Supabase…');
  await syncNow(false);
  if(supaLastSync){
    await addLog('Perfil','Sincronização Supabase configurada');
    if(!supaTimer)supaTimer=setInterval(()=>syncNow(true),30000);
  }
  renderProfile();
}
function clearSupabaseCfg(){
  try{localStorage.removeItem('biblioteca_supabase')}catch(e){}
  supaLastSync=0;
  if(supaTimer){clearInterval(supaTimer);supaTimer=null}
  if($('sbUrlInput'))$('sbUrlInput').value='';
  if($('sbKeyInput'))$('sbKeyInput').value='';
  renderProfile();
  toast('Supabase desconectado');
}
async function useLocalDb(){
  const key='biblioteca_convento_livros',logKey='biblioteca_convento_logs';
  let bCol,lCol;
  if(typeof indexedDB!=='undefined'){
    try{bCol=createIdbCol('livros',key);lCol=createIdbCol('logs',logKey)}catch(e){}
  }
  if(!bCol){bCol=createLocalCol(key);lCol=createLocalCol(logKey)}
  col=createSupaCol('livros',bCol);
  logsCol=createSupaCol('logs',lCol);
  col.orderBy('criado','desc').onSnapshot(sn=>{$('dbBanner').hidden=true;books=sn.docs.map(d=>({id:d.id,...d.data()}));render()});
  logsCol.orderBy('criado','desc').onSnapshot(sn=>{logs=sn.docs.map(d=>({id:d.id,...d.data()}));renderHome();renderLogs()});
  if(getSupaCfg()){
    syncNow(true);
    if(!supaTimer)supaTimer=setInterval(()=>syncNow(true),30000);
  }
}
function getUsers(){try{return JSON.parse(localStorage.getItem('biblioteca_users')||'{}')}catch(e){return {}}}
function saveUsers(u){try{localStorage.setItem('biblioteca_users',JSON.stringify(u))}catch(e){}}
function getAppKey(k){try{return String((typeof window!=='undefined'&&((window.APP_CONFIG&&window.APP_CONFIG[k])||window[k]))||'').trim()}catch(e){return ''}}
function getGoogleCid(){try{return getAppKey('GOOGLE_CLIENT_ID')||String(localStorage.getItem('biblioteca_google_cid')||'').trim()}catch(e){return ''}}
function parseJwt(token){
  try{
    const part=String(token||'').split('.')[1];
    if(!part)return {};
    const b64=part.replace(/-/g,'+').replace(/_/g,'/');
    const json=decodeURIComponent(atob(b64).split('').map(c=>'%'+('00'+c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json)||{};
  }catch(e){return {}}
}
function toggleGoogleCfg(force){
  const box=$('gCfgBox');if(!box)return;
  box.hidden=typeof force==='boolean'?!force:!box.hidden;
  if(!box.hidden&&$('gCidInput')){$('gCidInput').value=getGoogleCid();$('gCidInput').focus()}
}
function saveGoogleCid(){
  const cid=($('gCidInput')&&$('gCidInput').value||'').trim();
  if(!cid){say('gStatus','Informe um Client ID válido.','warn');return}
  try{localStorage.setItem('biblioteca_google_cid',cid)}catch(e){}
  toggleGoogleCfg(false);
  initGoogleSignIn();
  toast('Client ID salvo ✔');
}
function clearGoogleCid(){
  try{localStorage.removeItem('biblioteca_google_cid')}catch(e){}
  if($('gCidInput'))$('gCidInput').value='';
  initGoogleSignIn();
}
function triggerGoogleSetup(){
  const cid=getGoogleCid();
  const g=typeof window!=='undefined'&&window.google&&window.google.accounts&&window.google.accounts.id;
  if(cid&&g){initGoogleSignIn();try{g.prompt()}catch(e){}return}
  say('loginMsg',cid?'Login com Google indisponível sem conexão.':'Login com Google ainda não habilitado. Entre com seu nome.','warn');
}
function handleGoogleCredential(resp){
  const p=parseJwt(resp&&resp.credential);
  const nome=String(p.name||p.email||'').trim();
  if(!nome){say('loginMsg','Não foi possível ler os dados da conta Google.','warn');return}
  const email=String(p.email||'').trim(),foto=String(p.picture||'').trim();
  const users=getUsers();
  const prev=users[nome]||{};
  users[nome]={...prev,pin:prev.pin||'',email,foto,tipo:'google',criado:prev.criado||Date.now()};
  saveUsers(users);
  currentUser=nome;
  try{localStorage.setItem('biblioteca_user',nome)}catch(e){}
  say('loginMsg','');
  renderAuth();tab(0);
  addLog('Acesso','Entrou com Google'+(email?' ('+email+')':''));
}
function initGoogleSignIn(){
  if(currentUser)return;
  const wrap=$('gBtnWrap'),fb=$('gFallbackBtn'),st=$('gStatus'),blk=$('googleLoginBlock');
  if(!wrap||!fb)return;
  if(blk)blk.hidden=false;
  const cid=getGoogleCid();
  const g=typeof window!=='undefined'&&window.google&&window.google.accounts&&window.google.accounts.id;
  if(cid&&g){
    try{
      g.initialize({client_id:cid,callback:handleGoogleCredential});
      wrap.innerHTML='';
      g.renderButton(wrap,{theme:'outline',size:'large',text:'signin_with',shape:'rectangular',width:320});
      fb.hidden=true;
      return;
    }catch(e){}
  }
  wrap.innerHTML='';
  fb.hidden=false;
  if(st)st.hidden=true;
}
function renderAuth(){
  const logged=!!currentUser;
  $('loginView').hidden=logged;
  $('appView').hidden=!logged;
  if(logged){
    $('userLabel').textContent=currentUser;
    const u=getUsers()[currentUser],av=$('userAvatar');
    if(av){
      if(u&&u.foto){av.src=u.foto;av.hidden=false}
      else{av.hidden=true;av.removeAttribute('src')}
    }
    renderHome();
    return;
  }
  const names=Object.keys(getUsers()).sort((a,b)=>a.localeCompare(b,'pt-BR'));
  $('knownUsers').hidden=!names.length;
  $('userChips').innerHTML=names.map(n=>{const u=getUsers()[n]||{};return `<button type="button" class="user-card" onclick="pickUser('${esc(n).replace(/'/g,"&#39;")}')"><span class="ua">${u.foto?`<img src="${esc(u.foto)}" alt="">`:esc(n.charAt(0).toUpperCase())}</span><span class="un">${esc(n)}<br><span class="uh">${u.pin?'Pede PIN':'Toque para entrar'}</span></span></button>`}).join('');
  initGoogleSignIn();
}
function togglePin(){
  const i=$('loginPin'),b=$('pinToggle');if(!i||!b)return;
  const show=i.type==='password';
  i.type=show?'text':'password';
  b.textContent=show?'Ocultar':'Mostrar';
  b.setAttribute('aria-pressed',show?'true':'false');
  b.setAttribute('aria-label',show?'Ocultar PIN':'Mostrar PIN');
}
function pickUser(name){
  $('loginNome').value=name;
  const u=getUsers()[name];
  if(!u||!u.pin)doLogin();
  else $('loginPin').focus();
}
function doLogin(){
  const nome=$('loginNome').value.trim(),pin=$('loginPin').value.trim();
  if(!nome){say('loginMsg','Informe seu nome para entrar.','warn');return}
  const users=getUsers();
  if(users[nome]){
    if(users[nome].pin&&users[nome].pin!==pin){say('loginMsg','PIN incorreto para '+nome+'.','warn');return}
    if(!users[nome].pin&&pin)users[nome].pin=pin;
  }else{
    users[nome]={pin,tipo:'local',criado:Date.now()};
  }
  saveUsers(users);
  currentUser=nome;
  try{localStorage.setItem('biblioteca_user',nome)}catch(e){}
  $('loginPin').value='';say('loginMsg','');
  renderAuth();tab(0);
  addLog('Acesso','Entrou no sistema');
}
function logout(){
  const who=currentUser;
  if(who)addLog('Acesso','Saiu do sistema');
  currentUser='';
  try{localStorage.removeItem('biblioteca_user')}catch(e){}
  renderAuth();
}
try{currentUser=localStorage.getItem('biblioteca_user')||''}catch(e){}
renderAuth();
async function addLog(acao,detalhes,livro=''){
  if(!logsCol)return;
  try{
    const id='l'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
    await logsCol.doc(id).set({acao,detalhes,livro,usuario:currentUser||'Sistema',criado:Date.now()});
  }catch(e){}
}
(async()=>{
  if(!window.claude){useLocalDb();return}
  const t=setTimeout(()=>{if(!col){const b=$('dbBanner');b.hidden=false;b.textContent='Banco de dados indisponível. Abra pelo claude.ai e entre na sua conta.'}},10000);
  try{
    const db=await claude.use('db');
    if(!db){clearTimeout(t);useLocalDb();return}
    col=db.collection('livros');
    col.orderBy('criado','desc').onSnapshot(sn=>{clearTimeout(t);$('dbBanner').hidden=true;books=sn.docs.map(d=>({id:d.id,...d.data()}));render()},e=>{$('dbBanner').hidden=false;$('dbBanner').textContent='Erro ao ler o acervo ('+e.code+').'});
  }catch(e){clearTimeout(t);useLocalDb()}
})();
function applyTheme(t){
  try{
    if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;localStorage.setItem('biblioteca_theme',t)}
    else{delete document.documentElement.dataset.theme;localStorage.removeItem('biblioteca_theme')}
  }catch(e){}
}
try{applyTheme(localStorage.getItem('biblioteca_theme')||'')}catch(e){}
function setTheme(t){
  applyTheme(t);
  renderProfile();
  toast('Tema atualizado ✔');
}
function applyFontSize(f){
  try{
    if(f==='lg'){document.documentElement.dataset.font='lg';localStorage.setItem('biblioteca_font','lg')}
    else{delete document.documentElement.dataset.font;localStorage.removeItem('biblioteca_font')}
  }catch(e){}
}
try{applyFontSize(localStorage.getItem('biblioteca_font')||'')}catch(e){}
function setFontSize(f){
  applyFontSize(f);
  renderProfile();
  toast('Tamanho da letra atualizado ✔');
}
function renderProfile(){
  if(!currentUser)return;
  const users=getUsers(),u=users[currentUser]||{};
  const av=$('profAv');
  if(av)av.innerHTML=u.foto?`<img src="${esc(u.foto)}" alt="${esc(currentUser)}">`:esc(currentUser.charAt(0).toUpperCase()||'?');
  $('profName').textContent=currentUser;
  const parts=[u.tipo==='google'?'Conta Google':'Conta local'];
  if(u.email)parts.push(u.email);
  if(u.role)parts.push(u.role);
  if(u.criado)parts.push('Desde '+new Date(u.criado).toLocaleDateString('pt-BR'));
  $('profMeta').textContent=parts.join(' · ');
  const myBooks=books.filter(b=>b.criadoPor===currentUser).length;
  const myLogs=logs.filter(l=>l.usuario===currentUser);
  const myLoans=myLogs.filter(l=>l.acao==='Empréstimo').length;
  $('profKpis').innerHTML=`<div class="kpi"><b>${myBooks}</b><span>Obras cadastradas</span></div><div class="kpi"><b>${myLoans}</b><span>Empréstimos feitos</span></div><div class="kpi"><b>${myLogs.length}</b><span>Registros no log</span></div>`;
  $('profNomeInput').value=currentUser;
  $('profRoleInput').value=u.role||'';
  $('profPinInput').value='';
  $('profRmPinBtn').hidden=!u.pin;
  say('profMsg','');
  let th='';try{th=localStorage.getItem('biblioteca_theme')||''}catch(e){}
  $('thAuto').classList.toggle('on',!th);
  $('thLight').classList.toggle('on',th==='light');
  $('thDark').classList.toggle('on',th==='dark');
  let fn='';try{fn=localStorage.getItem('biblioteca_font')||''}catch(e){}
  if($('fnStd'))$('fnStd').classList.toggle('on',!fn);
  if($('fnLg'))$('fnLg').classList.toggle('on',fn==='lg');
  const sb=getSupaCfg();
  if($('sbUrlInput'))$('sbUrlInput').value=sb?sb.url:'';
  if($('sbKeyInput'))$('sbKeyInput').value=sb?sb.key:'';
  if($('sbSyncBtn'))$('sbSyncBtn').hidden=!sb;
  if($('sbClearBtn'))$('sbClearBtn').hidden=!sb;
  if($('sbStatus'))say('sbStatus',sb?(supaLastSync?'Conectado ao Supabase · última sinc: '+new Date(supaLastSync).toLocaleTimeString('pt-BR'):'Supabase configurado'):'Modo local (sem Supabase configurado).',sb?'ok':'');
  const recent=myLogs.slice(0,8);
  $('profLogs').innerHTML=recent.length?recent.map(l=>`<div class="log-row"><div class="log-top"><span class="log-act">${esc(l.acao)}${l.livro?' · '+esc(l.livro):''}</span><span class="log-time">${new Date(l.criado||0).toLocaleString('pt-BR')}</span></div><div class="log-det">${esc(l.detalhes||'')}</div></div>`).join(''):'<p class="msg">Nenhuma atividade registrada ainda para este usuário.</p>';
}
async function saveProfile(){
  const novo=$('profNomeInput').value.trim(),role=$('profRoleInput').value.trim(),pin=$('profPinInput').value.trim();
  if(!novo){say('profMsg','Informe o nome de exibição.','warn');return}
  const users=getUsers(),oldName=currentUser,prev=users[oldName]||{criado:Date.now(),tipo:'local',pin:''};
  if(novo!==oldName&&users[novo]){say('profMsg','Já existe outro usuário com o nome “'+novo+'”.','warn');return}
  const diffs=[];
  if(novo!==oldName)diffs.push('Nome: '+oldName+' → '+novo);
  if((prev.role||'')!==role)diffs.push('Função: '+(prev.role||'vazio')+' → '+(role||'vazio'));
  if(pin)diffs.push(prev.pin?'PIN alterado':'PIN definido');
  const next={...prev,role,pin:pin||prev.pin||''};
  if(novo!==oldName)delete users[oldName];
  users[novo]=next;
  saveUsers(users);
  currentUser=novo;
  try{localStorage.setItem('biblioteca_user',novo)}catch(e){}
  if(novo!==oldName){
    if(col)for(const b of books)if(b.criadoPor===oldName)await col.doc(b.id).update({criadoPor:novo});
    if(logsCol)for(const l of logs)if(l.usuario===oldName)await logsCol.doc(l.id).update({usuario:novo});
  }
  renderAuth();
  renderProfile();
  if(diffs.length)await addLog('Perfil',diffs.join('; '));
  toast('Perfil salvo ✔');
}
async function removeProfilePin(){
  const users=getUsers(),u=users[currentUser];
  if(!u||!u.pin)return;
  u.pin='';
  saveUsers(users);
  renderProfile();
  await addLog('Perfil','PIN de acesso removido');
  toast('PIN removido ✔');
}
function tab(n){[0,1,2,3,4].forEach(i=>{$('p'+i).hidden=i!==n;$('t'+i).classList.toggle('on',i===n)});if(n===0)renderHome();if(n===2)render();if(n===3)renderLogs();if(n===4)renderProfile()}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function say(id,t,c){const m=$(id);m.textContent=t;m.className='msg '+(c||'')}
function normIsbn(s){return String(s||'').toUpperCase().replace(/[^0-9X]/g,'')}
function isValidIsbn10(s){
  if(!/^\d{9}[\dX]$/.test(s))return false;
  let sum=0;for(let i=0;i<10;i++)sum+=(10-i)*(s[i]==='X'?10:+s[i]);
  return sum%11===0;
}
function isValidIsbn13(s){
  if(!/^(978|979)\d{10}$/.test(s))return false;
  let sum=0;for(let i=0;i<13;i++)sum+=(+s[i])*(i%2?3:1);
  return sum%10===0;
}
function isbn10to13(s){
  const core='978'+s.slice(0,9);let sum=0;
  for(let i=0;i<12;i++)sum+=(+core[i])*(i%2?3:1);
  return core+((10-(sum%10))%10);
}
function isbn13to10(s){
  if(!s.startsWith('978'))return '';
  const core=s.slice(3,12);let sum=0;
  for(let i=0;i<9;i++)sum+=(+core[i])*(10-i);
  const r=(11-(sum%11))%11;
  return core+(r===10?'X':String(r));
}
function isbnVariants(code){
  if(isValidIsbn10(code))return [code,isbn10to13(code)];
  if(isValidIsbn13(code)){const a=isbn13to10(code);return a?[code,a]:[code]}
  return code?[code]:[];
}
function parseIsbn(raw){
  const code=normIsbn(raw);
  if(code.length===10)return {code,valid:isValidIsbn10(code),variants:isbnVariants(code)};
  if(code.length===13)return {code,valid:isValidIsbn13(code),variants:isbnVariants(code)};
  return {code,valid:false,variants:[]};
}
function resizePhoto(inp,cb){
  const f=inp.files&&inp.files[0];if(!f)return;
  const img=new Image();img.onload=()=>{
    const k=Math.min(1,480/Math.max(img.width,img.height)),c=document.createElement('canvas');
    c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    URL.revokeObjectURL(img.src);cb(c.toDataURL('image/jpeg',0.72));
  };
  img.src=URL.createObjectURL(f);
}
function pickPhoto(inp){
  resizePhoto(inp,url=>{photo=url;$('prev').src=photo;$('prev').hidden=false;$('readBtn').hidden=false});
}
function pickEditPhoto(inp){
  resizePhoto(inp,url=>{editPhoto=url;const p=$('ePrev');if(p){p.src=url;p.hidden=false}const rm=$('eRmCov');if(rm)rm.hidden=false});
}
let stream=null,scanning=false;
async function startScan(){
  if(scanning){stopScan();return}
  if(!('BarcodeDetector' in window)){say('scanMsg','Este navegador não lê códigos de barras. Digite o ISBN abaixo (use o Chrome no Android para escanear).','warn');return}
  try{
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
  }catch(e){say('scanMsg','Não foi possível abrir a câmera. Permita o acesso ou digite o ISBN.','warn');return}
  const v=$('vid');v.srcObject=stream;v.hidden=false;await v.play();
  scanning=true;$('scanBtn').textContent='✖ Parar câmera';say('scanMsg','Procurando código…');
  const det=new BarcodeDetector({formats:['ean_13','ean_8','upc_a']});
  const loop=async()=>{
    if(!scanning)return;
    try{
      const r=await det.detect(v);
      if(r.length){
        const hit=r.find(x=>parseIsbn(x.rawValue).valid)||r[0];
        const code=hit.rawValue;
        stopScan();$('isbn').value=code;if(navigator.vibrate)navigator.vibrate(120);lookup(code);return;
      }
    }catch(e){}
    setTimeout(loop,250);
  };loop();
}
function stopScan(){scanning=false;if(stream)stream.getTracks().forEach(t=>t.stop());$('vid').srcObject=null;$('vid').hidden=true;$('scanBtn').textContent='Escanear código de barras'}

function joinTitle(t,sub){
  t=(t||'').trim();sub=(sub||'').trim();
  if(!sub||t.toLowerCase().includes(sub.toLowerCase()))return t;
  return t+': '+sub;
}
async function fetchJson(url,ms=7000){
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),ms);
  try{
    const r=await fetch(url,{signal:ac.signal});
    if(!r.ok){const e=new Error('HTTP '+r.status);e.status=r.status;throw e}
    return await r.json();
  }finally{clearTimeout(timer)}
}
function cleanText(s){
  return String(s||'').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\n{3,}/g,'\n\n').trim();
}
const BOOK_META_KEYS=['author','cover','category','editora','ano','paginas','sinopse'];
function mergeBookMeta(target,src){
  if(!target||!src)return target||src||null;
  for(const k of BOOK_META_KEYS)if(!target[k]&&src[k])target[k]=src[k];
  return target;
}
function parseGoogleItem(best,items){
  const v=best&&best.volumeInfo;
  if(!v)return null;
  const pick=fn=>{for(const it of items){const r=fn(it,it&&it.volumeInfo||{});if(r)return r}return ''};
  const cover=pick((it,vi)=>{const il=vi.imageLinks||{},u=il.thumbnail||il.smallThumbnail||'';return u?u.replace(/^http:/,'https:').replace('&edge=curl',''):''});
  const sin=cleanText(pick((it,vi)=>vi.description||(it&&it.searchInfo&&it.searchInfo.textSnippet)||''));
  return {
    title:joinTitle(v.title,v.subtitle),
    author:Array.isArray(v.authors)?v.authors.filter(Boolean).join(', '):pick((it,vi)=>Array.isArray(vi.authors)?vi.authors.filter(Boolean).join(', '):''),
    cover,
    category:pick((it,vi)=>Array.isArray(vi.categories)&&vi.categories[0]?String(vi.categories[0]).split('/')[0].trim():''),
    editora:v.publisher||pick((it,vi)=>vi.publisher||''),
    ano:v.publishedDate?String(v.publishedDate):pick((it,vi)=>vi.publishedDate?String(vi.publishedDate):''),
    paginas:v.pageCount?String(v.pageCount):pick((it,vi)=>vi.pageCount?String(vi.pageCount):''),
    sinopse:sin,
    source:'Google Books'
  };
}
const ISBN_PROVIDERS=[
  {name:'BrasilAPI',async get(code){
    const d=await fetchJson('https://brasilapi.com.br/api/isbn/v1/'+encodeURIComponent(code));
    if(!d||!d.title)return null;
    const author=Array.isArray(d.authors)?d.authors.filter(Boolean).join(', '):(d.authors||'');
    const cat=Array.isArray(d.subjects)&&d.subjects[0]?String(d.subjects[0]).split('/')[0].trim():'';
    return {title:joinTitle(d.title,d.subtitle),author,cover:d.cover_url||'',category:cat,editora:String(d.publisher||'').trim(),ano:d.year?String(d.year):'',paginas:d.page_count?String(d.page_count):'',sinopse:cleanText(d.synopsis),source:'BrasilAPI'};
  }},
  {name:'Google Books',async get(code){
    const d=await fetchJson('https://www.googleapis.com/books/v1/volumes?q=isbn:'+encodeURIComponent(code)+(getAppKey('GOOGLE_BOOKS_API_KEY')?'&key='+encodeURIComponent(getAppKey('GOOGLE_BOOKS_API_KEY')):''));
    const items=Array.isArray(d&&d.items)?d.items:[];
    const best=items.find(x=>x&&x.volumeInfo&&x.volumeInfo.title&&Array.isArray(x.volumeInfo.authors)&&x.volumeInfo.authors.length)||items.find(x=>x&&x.volumeInfo&&x.volumeInfo.title);
    return parseGoogleItem(best,items);
  }},
  {name:'Open Library',async get(code){
    const key='ISBN:'+code;
    const d=await fetchJson('https://openlibrary.org/api/books?bibkeys='+encodeURIComponent(key)+'&format=json&jscmd=data');
    const b=d&&d[key];
    if(!b||!b.title)return null;
    const author=Array.isArray(b.authors)&&b.authors.length?b.authors.map(a=>a&&a.name).filter(Boolean).join(', '):(b.by_statement||'');
    const cv=b.cover||{},ex=Array.isArray(b.excerpts)&&b.excerpts[0]&&b.excerpts[0].text;
    return {title:joinTitle(b.title,b.subtitle),author,cover:cv.medium||cv.large||cv.small||'',category:Array.isArray(b.subjects)&&b.subjects[0]?b.subjects[0].name:'',editora:Array.isArray(b.publishers)&&b.publishers[0]?b.publishers[0].name:'',ano:b.publish_date||'',paginas:b.number_of_pages?String(b.number_of_pages):'',sinopse:cleanText(b.notes||ex||''),source:'Open Library'};
  }},
  {name:'Open Library Search',async get(code){
    const d=await fetchJson('https://openlibrary.org/search.json?isbn='+encodeURIComponent(code)+'&fields=title,subtitle,author_name,publisher,first_publish_year,number_of_pages_median,subject,cover_i&limit=3');
    const docs=Array.isArray(d&&d.docs)?d.docs:[];
    const doc=docs.find(x=>x&&x.title&&Array.isArray(x.author_name)&&x.author_name.length)||docs.find(x=>x&&x.title);
    if(!doc)return null;
    return {
      title:joinTitle(doc.title,doc.subtitle),
      author:Array.isArray(doc.author_name)?doc.author_name.filter(Boolean).join(', '):'',
      cover:doc.cover_i?'https://covers.openlibrary.org/b/id/'+doc.cover_i+'-L.jpg?default=false':'',
      category:Array.isArray(doc.subject)&&doc.subject[0]?String(doc.subject[0]).split('/')[0].trim():'',
      editora:Array.isArray(doc.publisher)&&doc.publisher[0]?String(doc.publisher[0]):'',
      ano:doc.first_publish_year?String(doc.first_publish_year):'',
      paginas:doc.number_of_pages_median?String(doc.number_of_pages_median):'',
      sinopse:'',
      source:'Open Library'
    };
  }}
];
async function queryIsbnProviders(code){
  let reachable=false;
  const results=await Promise.all(ISBN_PROVIDERS.map(async p=>{
    try{
      const book=await p.get(code);
      reachable=true;
      return book;
    }catch(e){
      if(e&&(e.status===400||e.status===404))reachable=true;
      return null;
    }
  }));
  const found=results.find(Boolean);
  if(found)for(const r of results)mergeBookMeta(found,r);
  return {book:found||null,reachable};
}
async function queryWikiSummary(title){
  if(!title)return null;
  try{
    const sUrl='https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch='+encodeURIComponent(title)+'&format=json&origin=*&srlimit=1';
    const sd=await fetchJson(sUrl,4000);
    const hit=sd&&sd.query&&Array.isArray(sd.query.search)&&sd.query.search[0];
    if(!hit||!hit.pageid)return null;
    const norm=x=>String(x||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'').trim();
    const t1=norm(title),t2=norm(hit.title);
    if(!t1||!t2||(!t2.startsWith(t1.slice(0,14))&&!t1.startsWith(t2.slice(0,14))))return null;
    const eUrl='https://pt.wikipedia.org/w/api.php?action=query&prop=extracts|pageimages&exintro=1&explaintext=1&pithumbsize=400&pageids='+hit.pageid+'&format=json&origin=*';
    const ed=await fetchJson(eUrl,4000);
    const pg=ed&&ed.query&&ed.query.pages&&ed.query.pages[String(hit.pageid)];
    if(!pg||!pg.extract)return null;
    const ext=String(pg.extract).split('\n')[0].trim();
    if(!/(livro|obra|tratado|romance|escrito|publicad|autor|santo|teolog)/i.test(ext))return null;
    return {sinopse:ext.slice(0,700),cover:(pg.thumbnail&&pg.thumbnail.source)||''};
  }catch(e){return null}
}
async function queryByTitleAuthor(title,author){
  if(!title)return null;
  const out={};
  const olUrl='https://openlibrary.org/search.json?title='+encodeURIComponent(title)+(author?'&author='+encodeURIComponent(author.split(',')[0].trim()):'')+'&fields=title,subtitle,author_name,publisher,first_publish_year,number_of_pages_median,subject,cover_i&limit=3';
  const gbUrl='https://www.googleapis.com/books/v1/volumes?q='+encodeURIComponent('intitle:'+title+(author?' inauthor:'+author.split(',')[0].trim():''))+'&maxResults=3'+(getAppKey('GOOGLE_BOOKS_API_KEY')?'&key='+encodeURIComponent(getAppKey('GOOGLE_BOOKS_API_KEY')):'');
  const [olRes,gbRes]=await Promise.all([
    fetchJson(olUrl,4500).then(d=>{
      const docs=Array.isArray(d&&d.docs)?d.docs:[];
      const doc=docs.find(x=>x&&x.title&&Array.isArray(x.author_name)&&x.author_name.length)||docs[0];
      if(!doc)return null;
      return {
        author:Array.isArray(doc.author_name)?doc.author_name.filter(Boolean).join(', '):'',
        cover:doc.cover_i?'https://covers.openlibrary.org/b/id/'+doc.cover_i+'-L.jpg?default=false':'',
        category:Array.isArray(doc.subject)&&doc.subject[0]?String(doc.subject[0]).split('/')[0].trim():'',
        editora:Array.isArray(doc.publisher)&&doc.publisher[0]?String(doc.publisher[0]):'',
        ano:doc.first_publish_year?String(doc.first_publish_year):'',
        paginas:doc.number_of_pages_median?String(doc.number_of_pages_median):'',
        sinopse:''
      };
    }).catch(()=>null),
    fetchJson(gbUrl,4500).then(d=>{
      const items=Array.isArray(d&&d.items)?d.items:[];
      const tLow=title.toLowerCase();
      const best=items.find(x=>x&&x.volumeInfo&&x.volumeInfo.title&&x.volumeInfo.title.toLowerCase().includes(tLow.slice(0,12)))||items[0];
      return parseGoogleItem(best,items);
    }).catch(()=>null)
  ]);
  if(olRes)mergeBookMeta(out,olRes);
  if(gbRes)mergeBookMeta(out,gbRes);
  if(!out.sinopse){
    const wk=await queryWikiSummary(title);
    if(wk)mergeBookMeta(out,wk);
  }
  return Object.keys(out).length?out:null;
}
async function resolveBookByVariants(variants){
  let res=await queryIsbnProviders(variants[0]);
  const missing=b=>!b||BOOK_META_KEYS.some(k=>!b[k]);
  if(variants[1]&&missing(res.book)){
    const alt=await queryIsbnProviders(variants[1]);
    if(alt.book)res.book=res.book?mergeBookMeta(res.book,alt.book):alt.book;
    res.reachable=res.reachable||alt.reachable;
  }
  if(res.book&&missing(res.book)){
    const fb=await queryByTitleAuthor(res.book.title,res.book.author);
    if(fb)mergeBookMeta(res.book,fb);
  }
  return res;
}

function imgOk(url,ms=6000){
  return new Promise(res=>{
    if(!url)return res(false);
    const i=new Image(),t=setTimeout(()=>res(false),ms);
    i.onload=()=>{clearTimeout(t);res(i.naturalWidth>1&&i.naturalHeight>1)};
    i.onerror=()=>{clearTimeout(t);res(false)};
    i.src=url;
  });
}
async function findCover(book,codes){
  const urls=[book&&book.cover,...codes.map(c=>'https://covers.openlibrary.org/b/isbn/'+c+'-L.jpg?default=false')].filter(Boolean);
  for(const u of urls)if(await imgOk(u))return u;
  return '';
}
function setCover(url){
  photo=url||'';
  const p=$('prev');p.src=photo;p.hidden=!photo;$('readBtn').hidden=true;
}
async function lookup(raw){
  const seq=++lookupSeq;
  const parsed=parseIsbn(raw);
  if(!parsed.valid){
    say('scanMsg',parsed.code.length===10||parsed.code.length===13?'ISBN inválido (dígito verificador incorreto).':'ISBN inválido. Informe 10 ou 13 dígitos.','warn');
    return;
  }
  const code=parsed.code,variants=parsed.variants;
  $('isbn').value=code;
  const ex=books.find(b=>variants.includes(normIsbn(b.isbn)));
    if(ex){
    say('scanMsg','Este livro já está cadastrado: “'+ex.titulo+'”. Salvar de novo soma um exemplar.','warn');
    $('titulo').value=ex.titulo;$('autor').value=ex.autor;$('local').value=ex.local;$('categoria').value=ex.categoria||'';$('sinopse').value=ex.sinopse||'';
    if($('editora'))$('editora').value=ex.editora||'';if($('ano'))$('ano').value=ex.ano||'';if($('paginas'))$('paginas').value=ex.paginas||'';
    return;
  }
  const btn=$('lookupBtn');btn.disabled=true;btn.textContent='Buscando…';
  pendingMeta={};
  say('scanMsg','Buscando dados do livro…');
  try{
    const res=await resolveBookByVariants(variants);
    if(seq!==lookupSeq)return;
    if(res.book){
      $('titulo').value=res.book.title||'';
      $('autor').value=res.book.author||'';
      if(!$('categoria').value&&res.book.category)$('categoria').value=res.book.category;
      if(res.book.sinopse)$('sinopse').value=res.book.sinopse;
      if($('editora'))$('editora').value=res.book.editora||'';
      if($('ano'))$('ano').value=res.book.ano||'';
      if($('paginas'))$('paginas').value=res.book.paginas||'';
      pendingMeta={editora:res.book.editora||'',ano:res.book.ano||'',paginas:res.book.paginas||''};
      say('scanMsg','Livro encontrado ('+res.book.source+')! Buscando capa…','ok');
      const cv=await findCover(res.book,variants);
      if(seq!==lookupSeq)return;
      if(cv&&!$('foto').value)setCover(cv);
      say('scanMsg','Livro encontrado ('+res.book.source+')'+(cv?' com capa':'')+'! Confira os dados e informe onde ele fica.','ok');
      ($('local').value?$('titulo'):$('local')).focus();
      return;
    }
    const cv0=await findCover(null,variants);if(seq!==lookupSeq)return;if(cv0&&!$('foto').value)setCover(cv0);
    if(window.claude){await guess(code)}
    else if(!res.reachable){say('scanMsg','Não foi possível consultar as bases online (sem conexão ou acesso bloqueado). Preencha título e autor manualmente.','warn');$('titulo').focus()}
    else{say('scanMsg','ISBN '+code+' não encontrado nas bases consultadas. Preencha título e autor, ou use a foto da capa.','warn');$('titulo').focus()}
  }finally{
    if(seq===lookupSeq){btn.disabled=false;btn.textContent='Buscar'}
  }
}

function toBlob(u){const a=u.split(','),bin=atob(a[1]),n=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)n[i]=bin.charCodeAt(i);return new Blob([n],{type:'image/jpeg'})}
async function ask(prompt,opts){
  const s=window.claude&&await claude.use('sample');
  if(!s)throw {code:'unavailable'};
  return s.json(prompt,Object.assign({modelTier:'quick'},opts||{}));
}
async function guess(code){
  say('scanMsg','Código lido: '+code+'. Consultando Claude…');
  try{
    const r=await ask('ISBN '+code+'. Se você reconhece este livro com segurança, responda só JSON {"titulo":"...","autor":"..."}. Se não tiver certeza, responda {"titulo":"","autor":""}. Não invente.');
    if(r&&r.titulo){$('titulo').value=r.titulo;$('autor').value=r.autor||'';say('scanMsg','Sugestão do Claude (confira antes de salvar). Tirar uma foto da capa dá resultado mais seguro.','ok')}
    else say('scanMsg','Não reconheci este ISBN. Tire uma foto da capa e toque em “Ler título e autor da foto”, ou preencha à mão.','warn');
  }catch(e){say('scanMsg','Código lido: '+code+'. Preencha título e autor, ou use a foto da capa.','warn')}
}
async function readPhoto(){
  if(!photo||!photo.startsWith('data:'))return;
  const b=$('readBtn');b.disabled=true;b.textContent='Lendo a capa…';
  try{
    const r=await ask('Esta é a capa de um livro. Leia o texto da imagem e responda só JSON {"titulo":"...","autor":"..."}. Use "" para o que não estiver legível.',{images:[toBlob(photo)]});
    if(r&&r.titulo)$('titulo').value=r.titulo;if(r&&r.autor)$('autor').value=r.autor;
    say('saveMsg','Dados lidos da capa. Confira antes de salvar.','ok');
  }catch(e){say('saveMsg','Não foi possível ler a capa agora. Preencha à mão.','warn')}
  b.disabled=false;b.textContent='Ler título e autor da foto';
}
async function save(){
  const titulo=$('titulo').value.trim();
  if(!col){say('saveMsg','Sem conexão com o banco de dados.','warn');return}
  if(!titulo){say('saveMsg','Informe ao menos o título.','warn');return}
  const categoria=$('categoria').value.trim(),sinopse=$('sinopse').value.trim(),isbn=normIsbn($('isbn').value),qtd=Math.max(1,+$('qtd').value||1);
  const meta={editora:($('editora')?$('editora').value.trim():pendingMeta.editora)||'',ano:($('ano')?$('ano').value.trim():pendingMeta.ano)||'',paginas:($('paginas')?$('paginas').value.trim():pendingMeta.paginas)||''};
  const variants=isbnVariants(isbn);
  const ex=isbn&&books.find(b=>{const bi=normIsbn(b.isbn);return bi&&(bi===isbn||variants.includes(bi))});
  try{
    if(ex){const u={qtd:(ex.qtd||1)+qtd};if(photo)u.foto=photo;if(categoria)u.categoria=categoria;if(sinopse)u.sinopse=sinopse;if(meta.editora&&!ex.editora)u.editora=meta.editora;if(meta.ano&&!ex.ano)u.ano=meta.ano;if(meta.paginas&&!ex.paginas)u.paginas=meta.paginas;await col.doc(ex.id).update(u);await addLog('Cadastro','Somou '+qtd+' exemplar(es)',ex.titulo)}
    else{await col.doc(isbn?'isbn'+isbn:'b'+Date.now()).set({isbn,titulo,autor:$('autor').value.trim(),local:$('local').value.trim(),categoria,sinopse,...meta,qtd,emp:[],foto:photo,criado:Date.now(),criadoPor:currentUser||''});await addLog('Cadastro','Novo livro ('+qtd+' ex.)',titulo)}
    pendingMeta={};
    ['isbn','titulo','autor','categoria','sinopse','editora','ano','paginas'].forEach(i=>{if($(i))$(i).value=''});$('qtd').value=1;$('foto').value='';photo='';$('prev').hidden=true;$('readBtn').hidden=true;
    say('saveMsg','✔ “'+titulo+'” salvo no acervo. Escaneie o próximo livro.','ok');toast('Livro registrado ✔');window.scrollTo({top:0,behavior:'smooth'});say('scanMsg','Aponte a câmera para o código de barras na contracapa.');
  }catch(err){say('saveMsg','Não foi possível salvar ('+(err&&(err.code||err.name)||'erro')+'). Você precisa ter permissão de edição.','warn')}
}
function hue(t){let h=0;for(const c of String(t))h=(h*31+c.charCodeAt(0))>>>0;return COLORS[h%COLORS.length]}
function toast(t){const e=$('toast');e.textContent=t;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),2600)}
function normLoan(x){
  if(x&&typeof x==='object')return {nome:String(x.nome||'').trim(),retiradoEm:+x.retiradoEm||0,prazo:Math.max(1,+x.prazo||15)};
  return {nome:String(x||'').trim(),retiradoEm:0,prazo:15};
}
function loanInfo(x){
  const l=normLoan(x);
  if(!l.retiradoEm)return {nome:l.nome,dias:0,atraso:0,prazo:l.prazo,retiradoEm:0};
  const dias=Math.max(0,Math.floor((Date.now()-l.retiradoEm)/86400000));
  return {nome:l.nome,dias,atraso:Math.max(0,dias-l.prazo),prazo:l.prazo,retiradoEm:l.retiradoEm};
}
function loanTagHtml(x){
  const inf=loanInfo(x);
  if(!inf.retiradoEm)return `<b>${esc(inf.nome)}</b>`;
  return `<b>${esc(inf.nome)}</b> · ${inf.atraso>0?`<span class="tag out" style="margin:0">Vencido há ${inf.atraso}d</span>`:`${inf.dias}d/${inf.prazo}d`}`;
}
function free(b){return (b.qtd||1)-(b.emp||[]).length}
function setFilt(f){filt=f;render()}
function render(){
  const q=$('q').value.trim().toLowerCase(),qIsbn=normIsbn(q),qVars=isbnVariants(qIsbn);
  const nTit=books.length,nEx=books.reduce((s,b)=>s+(b.qtd||0),0),nOut=books.reduce((s,b)=>s+(b.emp||[]).length,0);
  $('stats').textContent=nTit?nTit+' títulos · '+nEx+' exemplares · '+nOut+' emprestado(s)':'Nenhum livro cadastrado ainda';
  $('navN').textContent=nTit;
  const locs=[...new Set(books.map(b=>(b.local||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const cats=[...new Set(books.map(b=>(b.categoria||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  const DEF=['Bíblia e Teologia','Espiritualidade','Vida dos Santos','História da Igreja','Liturgia','Filosofia','Literatura','Infantil','Outros'];
  $('cats').innerHTML=[...new Set([...cats,...DEF])].map(c=>'<option value="'+esc(c)+'">').join('');
  const cs=$('catSel'),cur=cs.value||'';
  cs.innerHTML='<option value="">Todas as categorias</option>'+cats.map(c=>'<option value="'+esc(c)+'"'+(c===cur?' selected':'')+'>'+esc(c)+'</option>').join('');
  const ls=$('locSel'),curLoc=ls?ls.value||'':'';
  if(ls)ls.innerHTML='<option value="">Todas as localizações</option>'+locs.map(lc=>'<option value="'+esc(lc)+'"'+(lc===curLoc?' selected':'')+'>'+esc(lc)+'</option>').join('');
  $('locais').innerHTML=locs.map(l=>'<option value="'+esc(l)+'">').join('');
  $('chips').innerHTML=[['all','Todos',nTit],['in','Disponíveis',books.filter(b=>free(b)>0).length],['out','Emprestados',books.filter(b=>(b.emp||[]).length).length]]
    .map(([k,n,c])=>`<button class="chip ${filt===k?'on':''}" onclick="setFilt('${k}')">${n} (${c})</button>`).join('');
  let l=books.filter(b=>{
    if(filt==='in'&&free(b)<=0)return false;
    if(filt==='out'&&!(b.emp||[]).length)return false;
    if(cs.value&&(b.categoria||'')!==cs.value)return false;
    if(ls&&ls.value&&(b.local||'')!==ls.value)return false;
    if(!q)return true;
    if(((b.titulo||'')+' '+(b.autor||'')+' '+(b.categoria||'')+' '+(b.local||'')+' '+(b.isbn||'')).toLowerCase().includes(q))return true;
    const bi=normIsbn(b.isbn);
    return qIsbn.length>=3&&bi&&(bi.includes(qIsbn)||qVars.includes(bi));
  });
  const so=$('sort').value,cmp=(k)=>(a,b)=>(a[k]||'').localeCompare(b[k]||'','pt-BR',{sensitivity:'base'});
  if(so==='tit')l.sort(cmp('titulo'));else if(so==='aut')l.sort(cmp('autor'));else if(so==='loc')l.sort(cmp('local'));
  $('list').className=view==='grid'?'grid':'';$('viewBtn').textContent=view==='grid'?'Lista':'Estante';
  say('count',l.length===nTit?'':l.length+' de '+nTit+' títulos');
  $('list').innerHTML=l.length?l.map(b=>{
    const emp=b.emp||[],f=free(b),qt=b.qtd||1;
    const meta=[b.categoria?`<span class="cat">${esc(b.categoria)}</span>`:'',esc(b.local||'Sem localização'),b.isbn?'ISBN '+esc(b.isbn):''].filter(Boolean).join(' · ');
    return `<article class="bk" tabindex="0" onclick="openBook('${b.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openBook('${b.id}')}">${bookCover(b)}<div class="info"><h3>${esc(b.titulo)}</h3><div class="by">${esc(b.autor||'Autor não informado')}</div>
    <div class="meta">${meta}</div>
    <span class="tag ${f>0?'in':'out'}">${f} de ${qt} disponível(is)</span>
    ${emp.map((n,i)=>`<div class="loan"><span>Emprestado para ${loanTagHtml(n)}</span><button class="btn alt sm" onclick="event.stopPropagation();ret('${b.id}',${i})">Devolvido</button></div>`).join('')}
    <div class="acts">${f>0?`<button class="btn sm" onclick="event.stopPropagation();lend('${b.id}')">Emprestar</button>`:''}<button class="btn alt sm" onclick="event.stopPropagation();editBook('${b.id}')">Editar</button><button class="btn alt sm danger" onclick="event.stopPropagation();del('${b.id}')">Remover</button></div></div></article>`}).join('')
    :`<div class="empty">${nTit?'Nenhum livro encontrado com esses filtros.':'O acervo está vazio. Cadastre o primeiro livro na aba Cadastrar.'}</div>`;
  if(openBookId&&!editMode)renderModal(openBookId);
  renderHome();
}
function renderHome(){
  if(!$('homeKpis'))return;
  const nTit=books.length,nEx=books.reduce((s,b)=>s+(b.qtd||0),0),nOut=books.reduce((s,b)=>s+(b.emp||[]).length,0),nDisp=Math.max(0,nEx-nOut);
  $('homeHello').textContent=currentUser?'Olá, '+currentUser:'Bem-vindo';
  $('homeDate').textContent=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'});
  $('homeKpis').innerHTML=[['Títulos',nTit],['Exemplares',nEx],['Disponíveis',nDisp],['Emprestados',nOut]].map(([k,v])=>`<div class="kpi"><b>${v}</b><span>${k}</span></div>`).join('');
  const loans=[];
  books.forEach(b=>(b.emp||[]).forEach((p,i)=>loans.push({b,p,i,inf:loanInfo(p)})));
  loans.sort((a,b)=>b.inf.atraso-a.inf.atraso||(a.inf.retiradoEm||0)-(b.inf.retiradoEm||0));
  $('homeLoans').innerHTML=loans.length?loans.map(({b,p,i})=>`<div class="loan"><span><b>${esc(b.titulo)}</b> — com ${loanTagHtml(p)}</span><button type="button" class="btn alt sm" onclick="ret('${b.id}',${i})">Devolvido</button></div>`).join(''):'<p class="msg">Nenhum livro emprestado no momento.</p>';
  const rec=logs.slice(0,5);
  $('homeLogs').innerHTML=rec.length?rec.map(l=>`<div class="log-row"><div class="log-top"><span class="log-act">${esc(l.acao)}</span><span class="log-time">${new Date(l.criado).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span></div><div class="log-det">${l.livro?'<b>'+esc(l.livro)+'</b> — ':''}${esc(l.detalhes)}</div><div class="log-who">Por ${esc(l.usuario||'Sistema')}</div></div>`).join(''):'<p class="msg">Nenhuma atividade registrada ainda.</p>';
}
function renderLogs(){
  if(!$('logList'))return;
  const q=($('logQ').value||'').trim().toLowerCase(),tp=$('logType').value||'';
  const l=logs.filter(x=>(!tp||x.acao===tp)&&(!q||((x.usuario||'')+' '+(x.livro||'')+' '+(x.detalhes||'')+' '+(x.acao||'')).toLowerCase().includes(q)));
  $('logList').innerHTML=l.length?l.map(x=>`<div class="log-row"><div class="log-top"><span class="log-act">${esc(x.acao)}</span><span class="log-time">${new Date(x.criado).toLocaleString('pt-BR')}</span></div><div class="log-det">${x.livro?'<b>'+esc(x.livro)+'</b> — ':''}${esc(x.detalhes)}</div><div class="log-who">Por ${esc(x.usuario||'Sistema')}</div></div>`).join(''):'<p class="msg" style="padding:12px 0">Nenhum registro encontrado.</p>';
}
function bookCover(b){
  const init=esc((b.titulo||'?').trim().charAt(0).toUpperCase()),bg=hue(b.titulo);
  if(!b.foto)return `<div class="cover ph" style="background-color:${bg}" aria-hidden="true">${init}</div>`;
  return `<div class="cover"><img src="${esc(b.foto)}" alt="Capa de ${esc(b.titulo)}" loading="lazy" onerror="const p=this.parentNode;p.className='cover ph';p.style.backgroundColor='${bg}';p.setAttribute('aria-hidden','true');p.textContent='${init}'"></div>`;
}
function openBook(id){
  if(!books.some(b=>b.id===id))return;
  openBookId=id;editMode=false;renderModal(id);$('bookModal').hidden=false;
}
function editBook(id){
  const b=books.find(x=>x.id===id);if(!b)return;
  openBookId=id;editMode=true;editPhoto=b.foto||'';renderModal(id);$('bookModal').hidden=false;
  const t=$('eTitulo');if(t)t.focus();
}
function clearEditCover(){
  editPhoto='';const p=$('ePrev');if(p){p.src='';p.hidden=true}
  const rm=$('eRmCov');if(rm)rm.hidden=true;
  const f=$('eFoto');if(f)f.value='';
}
function closeBook(){openBookId='';editMode=false;editPhoto='';$('bookModal').hidden=true}
function renderModal(id){
  const b=books.find(x=>x.id===id);
  if(!b){closeBook();return}
  const emp=b.emp||[],f=free(b),qt=b.qtd||1;
  if(editMode){
    $('bookSheet').innerHTML=`<div class="sheet-hd"><span id="dlgTitle">Editar obra</span><button class="xbtn" onclick="closeBook()" aria-label="Fechar">✕</button></div>
    <form onsubmit="event.preventDefault();saveEdit('${b.id}')">
    <label for="eTitulo">Título</label><input id="eTitulo" value="${esc(b.titulo||'')}" required>
    <label for="eAutor">Autor</label><input id="eAutor" value="${esc(b.autor||'')}">
    <div class="grid2">
    <div><label for="eCat">Categoria</label><input id="eCat" value="${esc(b.categoria||'')}" list="cats" autocomplete="off"></div>
    <div><label for="eLocal">Onde fica</label><input id="eLocal" value="${esc(b.local||'')}" list="locais"></div>
    </div>
    <div class="grid2">
    <div style="display:flex;gap:6px;align-items:flex-end"><div style="flex:1"><label for="eIsbn">ISBN</label><input id="eIsbn" value="${esc(b.isbn||'')}" autocomplete="off" autocapitalize="characters"></div><button type="button" class="btn alt sm" id="eLookupBtn" onclick="lookupEdit()">Buscar</button></div>
    <div><label for="eQtd">Exemplares${emp.length?` (mín. ${emp.length})`:''}</label><input id="eQtd" type="number" min="${Math.max(1,emp.length)}" value="${qt}" inputmode="numeric"></div>
    </div>
    <div class="grid2">
    <div><label for="eEditora">Editora</label><input id="eEditora" value="${esc(b.editora||'')}"></div>
    <div><label for="eAno">Publicação</label><input id="eAno" value="${esc(b.ano||'')}"></div>
    </div>
    <div class="grid2">
    <div><label for="ePag">Páginas</label><input id="ePag" value="${esc(b.paginas||'')}" inputmode="numeric"></div>
    <div><label for="eFoto">Trocar capa</label><input id="eFoto" type="file" accept="image/*" capture="environment" onchange="pickEditPhoto(this)"></div>
    </div>
    <img id="ePrev" src="${esc(editPhoto)}" alt="Capa" ${editPhoto?'':'hidden'} style="width:76px;height:112px;object-fit:contain;background:var(--soft);border:1px solid var(--bd);margin-top:8px;display:block">
    <button type="button" class="btn alt sm danger" id="eRmCov" onclick="clearEditCover()" ${editPhoto?'':'hidden'} style="margin-top:6px">Remover capa</button>
    <label for="eSinopse">Sinopse</label><textarea id="eSinopse" rows="3">${esc(b.sinopse||'')}</textarea>
    <p class="msg warn" id="editMsg"></p>
    <div class="acts"><button type="submit" class="btn sm">Salvar alterações</button><button type="button" class="btn alt sm" onclick="openBook('${b.id}')">Cancelar</button></div>
    </form>`;
    return;
  }
  const info=[
    ['Localização',b.local||'Não informada'],
    ['Disponibilidade',`${f} de ${qt} exemplar(es)`],
    b.isbn&&['ISBN',b.isbn],
    b.editora&&['Editora',b.editora],
    b.ano&&['Publicação',b.ano],
    b.paginas&&['Páginas',b.paginas],
    b.criadoPor&&['Cadastrado por',b.criadoPor],
    b.criado&&['Cadastrado em',new Date(b.criado).toLocaleDateString('pt-BR')]
  ].filter(Boolean);
  $('bookSheet').innerHTML=`<div class="sheet-hd"><span>Detalhes da obra</span><button class="xbtn" onclick="closeBook()" aria-label="Fechar">✕</button></div>
  <div class="hero">${bookCover(b)}<div class="info"><h2 id="dlgTitle">${esc(b.titulo)}</h2><div class="by">${esc(b.autor||'Autor não informado')}</div>
  ${b.categoria?`<div class="meta"><span class="cat">${esc(b.categoria)}</span></div>`:''}
  <span class="tag ${f>0?'in':'out'}">${f>0?'Disponível':'Todos emprestados'}</span></div></div>
  <dl class="kv">${info.map(([k,v])=>`<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
  ${b.sinopse?`<div class="syn"><b>Sinopse</b><p>${esc(b.sinopse)}</p></div>`:(b.isbn?`<button class="btn alt sm" id="synBtn" onclick="fetchSynopsis('${b.id}')">Buscar sinopse</button>`:'')}
  ${emp.map((n,i)=>`<div class="loan"><span>Emprestado para ${loanTagHtml(n)}</span><button class="btn alt sm" onclick="ret('${b.id}',${i})">Devolvido</button></div>`).join('')}
  <div class="acts">${f>0?`<button class="btn sm" onclick="lend('${b.id}')">Emprestar</button>`:''}<button class="btn alt sm" onclick="editBook('${b.id}')">Editar</button><button class="btn alt sm danger" onclick="del('${b.id}')">Remover</button><button class="btn alt sm" onclick="closeBook()">Fechar</button></div>`;
}
async function lookupEdit(){
  const parsed=parseIsbn($('eIsbn').value);
  if(!parsed.valid){say('editMsg','Informe um ISBN válido (10 ou 13 dígitos) para buscar.','warn');return}
  $('eIsbn').value=parsed.code;
  const btn=$('eLookupBtn');if(btn){btn.disabled=true;btn.textContent='…'}
  say('editMsg','Buscando dados pelo ISBN…');
  try{
    const res=await resolveBookByVariants(parsed.variants);
    const bk=res.book;
    if(!bk){say('editMsg','Nenhum dado encontrado para este ISBN.','warn');return}
    if(!$('eTitulo').value.trim()&&bk.title)$('eTitulo').value=bk.title;
    if(!$('eAutor').value.trim()&&bk.author)$('eAutor').value=bk.author;
    if(!$('eCat').value.trim()&&bk.category)$('eCat').value=bk.category;
    if(!$('eEditora').value.trim()&&bk.editora)$('eEditora').value=bk.editora;
    if(!$('eAno').value.trim()&&bk.ano)$('eAno').value=bk.ano;
    if(!$('ePag').value.trim()&&bk.paginas)$('ePag').value=bk.paginas;
    if(!$('eSinopse').value.trim()&&bk.sinopse)$('eSinopse').value=bk.sinopse;
    if(!editPhoto){
      const cv=await findCover(bk,parsed.variants);
      if(cv){editPhoto=cv;if($('ePrev')){$('ePrev').src=cv;$('ePrev').hidden=false}if($('eRmCov'))$('eRmCov').hidden=false}
    }
    say('editMsg','Dados preenchidos ('+bk.source+'). Revise e clique em Salvar alterações.','ok');
  }finally{if(btn){btn.disabled=false;btn.textContent='Buscar'}}
}
async function saveEdit(id){
  const b=books.find(x=>x.id===id);if(!b)return;
  const titulo=$('eTitulo').value.trim();
  if(!titulo){say('editMsg','Informe ao menos o título.','warn');return}
  const minQ=Math.max(1,(b.emp||[]).length),qtd=Math.max(1,+$('eQtd').value||1);
  if(qtd<minQ){say('editMsg','Há '+minQ+' exemplar(es) emprestado(s); a quantidade não pode ser menor.','warn');return}
  const patch={
    titulo,
    autor:$('eAutor').value.trim(),
    categoria:$('eCat').value.trim(),
    local:$('eLocal').value.trim(),
    isbn:normIsbn($('eIsbn').value),
    qtd,
    editora:$('eEditora').value.trim(),
    ano:$('eAno').value.trim(),
    paginas:$('ePag').value.trim(),
    sinopse:$('eSinopse').value.trim(),
    foto:editPhoto
  };
  const labels={titulo:'Título',autor:'Autor',categoria:'Categoria',local:'Localização',isbn:'ISBN',qtd:'Exemplares',editora:'Editora',ano:'Publicação',paginas:'Páginas',sinopse:'Sinopse',foto:'Capa'};
  const diffs=[];
  for(const k of Object.keys(labels)){
    const oldV=k==='qtd'?String(b.qtd||1):String(b[k]||'');
    const newV=String(patch[k]||'');
    if(oldV!==newV){
      if(k==='foto')diffs.push('Capa '+(newV?'atualizada':'removida'));
      else if(k==='sinopse')diffs.push('Sinopse atualizada');
      else diffs.push(labels[k]+': '+(oldV||'vazio')+' → '+(newV||'vazio'));
    }
  }
  editMode=false;
  await mut(id,()=>col.doc(id).update(patch));
  await addLog('Edição',diffs.length?diffs.join('; '):'Cadastro revisado sem alterações',titulo);
  renderModal(id);
  toast('Alterações salvas ✔');
}
async function fetchSynopsis(id){
  const b=books.find(x=>x.id===id);if(!b||!b.isbn)return;
  const btn=$('synBtn');if(btn){btn.disabled=true;btn.textContent='Buscando sinopse…'}
  const vars=isbnVariants(normIsbn(b.isbn));
  const res=await resolveBookByVariants(vars.length?vars:[b.isbn]);
  const bk=res.book;
  if(bk&&(bk.sinopse||bk.editora||bk.ano||bk.paginas)){
    const patch={};
    for(const k of ['sinopse','editora','ano','paginas'])if(!b[k]&&bk[k])patch[k]=bk[k];
    if(Object.keys(patch).length){
      await mut(id,()=>col.doc(id).update(patch));
      const fNames={sinopse:'Sinopse',editora:'Editora',ano:'Publicação',paginas:'Páginas'};
      await addLog('Edição','Dados buscados por ISBN: '+Object.keys(patch).map(k=>fNames[k]||k).join(', '),b.titulo);
    }
    toast(bk.sinopse?'Sinopse encontrada ✔':'Sinopse indisponível; dados atualizados');
  }else{
    toast('Sinopse não encontrada para este ISBN');
    if(btn){btn.disabled=false;btn.textContent='Buscar sinopse'}
  }
}
if(typeof addEventListener==='function')addEventListener('keydown',e=>{if(e.key==='Escape'&&openBookId)closeBook()});
async function mut(id,fn){const b=books.find(x=>x.id===id);try{await fn(b)}catch(e){alert('Sem permissão para alterar o acervo.')}}
function lend(id){
  const n=(prompt('Quem está levando o livro?')||'').trim();if(!n)return;
  const prazo=Math.max(1,parseInt(prompt('Prazo de devolução (em dias):','15')||'15',10)||15);
  const entry={nome:n,retiradoEm:Date.now(),prazo};
  mut(id,async b=>{await col.doc(id).update({emp:[...(b.emp||[]),entry]});await addLog('Empréstimo','Emprestado para '+n+' (prazo: '+prazo+' dias)',b.titulo)}).then(()=>toast('Empréstimo registrado'));
}
function ret(id,i){
  mut(id,async b=>{
    const a=[...(b.emp||[])],who=a.splice(i,1)[0],inf=loanInfo(who);
    await col.doc(id).update({emp:a});
    await addLog('Devolução','Devolvido'+(inf.nome?' por '+inf.nome:'')+(inf.retiradoEm?' ('+inf.dias+' dia(s))':''),b.titulo);
    toast('Devolução registrada');
  });
}
function del(id){const b=books.find(x=>x.id===id);if(confirm('Remover “'+(b&&b.titulo||'este livro')+'” do acervo?'))mut(id,async()=>{await col.doc(id).delete();await addLog('Remoção','Livro removido do acervo',b&&b.titulo||'')}).then(()=>toast('Livro removido'))}
function dlFile(name,content,type){
  const a=document.createElement('a'),u=URL.createObjectURL(new Blob([content],{type}));
  a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
}
function exportJson(){
  if(!books.length){toast('Nenhum livro para exportar');return}
  const day=new Date().toISOString().slice(0,10);
  dlFile('biblioteca-convento-'+day+'.json',JSON.stringify({version:2,exportedAt:new Date().toISOString(),books,logs},null,2),'application/json');
  addLog('Backup','Exportou backup JSON ('+books.length+' obra(s))');
  toast('Backup JSON exportado ✔');
}
function exportCsv(){
  if(!books.length){toast('Nenhum livro para exportar');return}
  const day=new Date().toISOString().slice(0,10);
  const cell=v=>'"'+String(v||'').replace(/"/g,'""')+'"';
  const cols=['titulo','autor','categoria','local','isbn','qtd','editora','ano','paginas','sinopse'];
  const head=['Título','Autor','Categoria','Localização','ISBN','Exemplares','Editora','Publicação','Páginas','Sinopse','Emprestado para'];
  const rows=[head.map(cell).join(';')];
  for(const b of books)rows.push([...cols.map(k=>cell(b[k])),cell((b.emp||[]).map(e=>normLoan(e).nome).join(', '))].join(';'));
  dlFile('biblioteca-convento-'+day+'.csv','\uFEFF'+rows.join('\r\n'),'text/csv;charset=utf-8');
  addLog('Backup','Exportou planilha CSV ('+books.length+' obra(s))');
  toast('Planilha CSV exportada ✔');
}
async function importBackup(inp){
  const f=inp.files&&inp.files[0];inp.value='';
  if(!f||!col)return;
  try{
    const parsed=JSON.parse(await f.text());
    const arr=Array.isArray(parsed)?parsed:(Array.isArray(parsed&&parsed.books)?parsed.books:null);
    if(!arr){toast('Arquivo de backup inválido');return}
    let n=0;
    for(const raw of arr){
      if(!raw||!String(raw.titulo||'').trim())continue;
      const isbn=normIsbn(raw.isbn),vars=isbnVariants(isbn);
      const ex=books.find(b=>b.id===raw.id||(isbn&&vars.includes(normIsbn(b.isbn))));
      const id=ex?ex.id:(raw.id||(isbn?'isbn'+isbn:'b'+Date.now()+'_'+n));
      const doc={
        isbn,titulo:String(raw.titulo).trim(),autor:String(raw.autor||'').trim(),
        local:String(raw.local||'').trim(),categoria:String(raw.categoria||'').trim(),
        sinopse:String(raw.sinopse||'').trim(),editora:String(raw.editora||'').trim(),
        ano:String(raw.ano||'').trim(),paginas:String(raw.paginas||'').trim(),
        qtd:Math.max(1,+raw.qtd||1),emp:Array.isArray(raw.emp)?raw.emp:[],
        foto:String(raw.foto||''),criado:+raw.criado||Date.now(),criadoPor:String(raw.criadoPor||'')
      };
      await col.doc(id).set(doc);
      n++;
    }
    if(logsCol&&Array.isArray(parsed&&parsed.logs)){
      for(const lg of parsed.logs)if(lg&&lg.id&&lg.acao)await logsCol.doc(lg.id).set(lg);
    }
    if(n)await addLog('Importação',n+' livro(s) importado(s) via backup');
    toast(n?n+' livro(s) importado(s) ✔':'Nenhum livro válido encontrado');
  }catch(e){toast('Erro ao ler o arquivo JSON')}
}
