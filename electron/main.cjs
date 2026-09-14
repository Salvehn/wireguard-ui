const {app,BrowserWindow,ipcMain,dialog,Menu,Tray,nativeImage,screen,nativeTheme,net} = require('electron');
const fs=require('node:fs/promises'), fsSync=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {parseConfig,redact}=require('./config.cjs');
const {defaults:smartDefaults,validateSettingsForSave,applySmartTunneling,hasWildcard}=require('./smart-tunneling.cjs');
const {validateApps,compileApps,enabled:appsEnabled}=require('./app-tunneling.cjs');
const {routeNotes,TunnelController}=require('./tunnels.cjs');

const {maskConfig,restoreConfig,revision}=require('./editor.cjs');
const {RuntimeStatus}=require('./runtime-status.cjs');
const helperClient=require('./helper-client.cjs');
const {assertUniqueProfile}=require('./profile-identity.cjs');
const {createLocale}=require('./locale.cjs');
const {createTheme}=require('./theme.cjs');
const {shutdownTunnels}=require('./shutdown.cjs');
const {createAppUpdater}=require('./updater.cjs');
const {launchUpdateWorker,markUpdateHealthy}=require('./update-worker.cjs');
let locale;const t=(source,values)=>locale?.t(source,values)||source;
let theme;
let refreshLocaleUI=()=>{};
let importing=false;
let runtime;let helper={status:'required',message:''};let helperSnapshot={profiles:{},updatedAt:0};let snapshotPending=null;let helperSetup=null;
let win,popover,tray,trayTimer,quitting=false,closing=false,dir,controller,statsBusy=false; let logs=[];const editing=new Set();
const log=message=>{logs=[...logs,{time:Date.now(),message:redact(message)}].slice(-100)};
async function backend(){return helper.status==='ready'?'WireGuard Desktop Helper':null}
async function updateSnapshot(ids,force=false){
 if(helper.status!=='ready')return;
 if(!force&&Date.now()-helperSnapshot.updatedAt<1500)return;
 if(snapshotPending)return snapshotPending;
 snapshotPending=helperClient.request({op:'snapshot',ids}).then(snapshot=>{helperSnapshot=snapshot}).catch(error=>{helperSnapshot={profiles:{},updatedAt:0};helper={status:'error',message:'Системный помощник недоступен. Нажмите «Настроить доступ».'};log(error.message)}).finally(()=>{snapshotPending=null});return snapshotPending;
}
async function setupHelper(){
 if(helperSetup)return helperSetup;
 helperSetup=(async()=>{helper={status:'installing',message:'macOS запрашивает разрешение на установку системного помощника'};try{
  if(!await helperClient.available())await helperClient.install(app.isPackaged?path.join(process.resourcesPath,'helper'):path.join(__dirname,'../build/helper'));
  helper={status:'ready',message:''};helperSnapshot.updatedAt=0;log('Системный помощник готов. Повторные запросы пароля не нужны.');
 }catch(error){helper={status:'required',message:'Для управления VPN установите системный помощник. Потребуется разрешение администратора.'};log(error.message)}finally{helperSetup=null}})();return helperSetup;
}
async function profiles(){ const files=await fs.readdir(dir);await updateSnapshot(files.filter(f=>/^wg[a-f0-9]{10}\.conf$/.test(f)).map(f=>f.slice(0,-5))); return Promise.all(files.filter(f=>/^wg[a-f0-9]{10}\.conf$/.test(f)).map(async file=>{const id=file.slice(0,-5);const meta=JSON.parse(await fs.readFile(path.join(dir,id+'.json'),'utf8'));const runtimeState=helperSnapshot.profiles[id]||await runtime.read(id);return {id,...meta,...parseConfig(await fs.readFile(path.join(dir,file),'utf8')),...runtimeState,stats:runtimeState.active?runtimeState.stats||null:null}}))}
async function state(){const all=await profiles();return {profiles:all.map(p=>({...p,notes:routeNotes(p,all)})),backend:await backend(),operations:Object.fromEntries(controller.pending),statsBusy,helper,logs}}
app.whenReady().then(async()=>{
 nativeTheme.themeSource='system';
 theme=createTheme(path.join(app.getPath('userData'),'theme.json'),()=>nativeTheme.shouldUseDarkColors);await theme.load();
 const applyAppearance=()=>{const color=theme.get().theme==='dark'?'#101416':'#f5f8f6';for(const window of BrowserWindow.getAllWindows())window.setBackgroundColor(color)};
 dir=path.join(app.getPath('userData'),'tunnels');await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);
 locale=createLocale(path.join(app.getPath('userData'),'locale.json'),()=>app.getPreferredSystemLanguages());await locale.load();
 runtime=new RuntimeStatus('/var/run/wireguard',path.join(app.getPath('userData'),'runtime-status.json'));await runtime.load();
 controller=new TunnelController({list:profiles,log,execute:async(profile,action)=>{
   if(helper.status!=='ready')throw Error('Сначала настройте системный помощник');
   const original=await fs.readFile(path.join(dir,profile.id+'.conf'),'utf8');
   const settings=profile.smartTunneling||smartDefaults();const appRules=validateApps(action==='up'?settings.applications:undefined);const useApps=action==='up'&&appsEnabled(appRules);const dynamic=action==='up'&&hasWildcard(settings);
   const config=action==='up'&&!dynamic&&!useApps?await applySmartTunneling(original,settings):original;
   try{const result=await helperClient.request({op:'setActive',id:profile.id,active:action==='up',config,...(useApps?{applications:appRules}:dynamic?{smartTunneling:settings}:{})});helperSnapshot.profiles={...helperSnapshot.profiles,...result.profiles};helperSnapshot.updatedAt=0;return result.output}
   finally{helperSnapshot.updatedAt=0}
 }});
 const authorized=event=>{if(event.sender!==win?.webContents&&event.sender!==popover?.webContents)throw Error('Unknown sender')};
 const mainOnly=event=>{if(event.sender!==win?.webContents)throw Error('Main window required')};
 const updateRolledBack=process.argv.includes('--update-rollback');
 const updater=createAppUpdater({app,fetch:(url,options)=>net.fetch(url,options),publicKey:fsSync.readFileSync(path.join(__dirname,'update-public-key.pem')),startupError:updateRolledBack?'Не удалось запустить новую версию. Предыдущая версия восстановлена.':'',publish:updateState=>{for(const window of BrowserWindow.getAllWindows())window.webContents.send('update-state-changed',updateState)},installUpdate:async update=>{
   await launchUpdateWorker({app,...update});quitting=true;if(trayTimer)clearInterval(trayTimer);if(closing)return;closing=true;
   await shutdownTunnels({profiles,downTunnel:profile=>controller.setActive(profile.id,false),log}).catch(error=>log(error.message));app.quit();
 }});
 ipcMain.handle('get-update-state',e=>{authorized(e);return updater.getState()});
 ipcMain.handle('check-for-updates',e=>{mainOnly(e);return updater.check()});
 ipcMain.handle('download-update',e=>{mainOnly(e);return updater.download()});
 ipcMain.handle('install-update',e=>{mainOnly(e);return updater.install()});
 let lastLocale=JSON.stringify(locale.get());
 const publishLocale=()=>{const current=locale.get();const signature=JSON.stringify(current);if(signature!==lastLocale){lastLocale=signature;for(const window of BrowserWindow.getAllWindows())window.webContents.send('locale-changed',current);refreshLocaleUI()}return current};
 ipcMain.handle('get-locale',e=>{authorized(e);return publishLocale()});
 ipcMain.handle('set-locale',async(e,preference)=>{authorized(e);await locale.set(preference);return publishLocale()});
 let lastTheme=JSON.stringify(theme.get());
 const publishTheme=()=>{const current=theme.get();const signature=JSON.stringify(current);if(signature!==lastTheme){lastTheme=signature;for(const window of BrowserWindow.getAllWindows())window.webContents.send('theme-changed',current);applyAppearance()}return current};
 nativeTheme.on('updated',publishTheme);
 ipcMain.handle('get-theme',e=>{authorized(e);return publishTheme()});
 ipcMain.handle('set-theme',async(e,preference)=>{authorized(e);await theme.set(preference);return publishTheme()});
 ipcMain.handle('state',async e=>{authorized(e);return state()});
 ipcMain.handle('setup-helper',async e=>{authorized(e);await setupHelper();return state()});
 ipcMain.handle('refresh-stats',async e=>{
   authorized(e);if(statsBusy)throw Error('Статистика уже обновляется');statsBusy=true;
   try{const ids=(await fs.readdir(dir)).filter(f=>/^wg[a-f0-9]{10}\.conf$/.test(f)).map(f=>f.slice(0,-5));await updateSnapshot(ids,true);return await state()}finally{statsBusy=false}
 });
 ipcMain.handle('import',async e=>{
  mainOnly(e);if(importing)throw Error('Импорт уже открыт');importing=true;
  try{
   const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'WireGuard',extensions:['conf']}]});if(result.canceled)return state();
   const file=result.filePaths[0];if((await fs.stat(file)).size>65536)throw Error('Конфиг слишком большой');const text=await fs.readFile(file,'utf8');const summary=parseConfig(text);const name=path.basename(file,'.conf').trim();
   const existing=await Promise.all((await fs.readdir(dir)).filter(f=>/^wg[a-f0-9]{10}\.json$/.test(f)).map(async f=>({name:JSON.parse(await fs.readFile(path.join(dir,f),'utf8')).name,config:await fs.readFile(path.join(dir,f.replace(/\.json$/,'.conf')),'utf8')})));
   assertUniqueProfile(name,text,existing);
   const id='wg'+crypto.randomBytes(5).toString('hex');const target=path.join(dir,id+'.conf');await fs.writeFile(target,text,{mode:0o600,flag:'wx'});
   try{await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({name,...summary}),{mode:0o600,flag:'wx'})}catch(error){await fs.rm(target,{force:true});throw error}
   helperSnapshot.updatedAt=0;log('Конфигурация импортирована');return state();
  }finally{importing=false}
 });
 ipcMain.handle('set-active',async(e,id,active)=>{authorized(e);if(editing.has(id))throw Error('Сохранение конфигурации');try{await controller.setActive(id,active)}catch{throw Error('Не удалось изменить состояние туннеля. Проверьте журнал событий.')}return state()});
 ipcMain.handle('remove',async(e,id)=>{mainOnly(e);if(editing.has(id))throw Error('Сохранение конфигурации');if(controller.pending.has(id))throw Error('Дождитесь завершения операции');const profile=(await profiles()).find(p=>p.id===id);if(!profile||profile.active||profile.statusUnknown)throw Error('Сначала отключите туннель');const answer=await dialog.showMessageBox(win,{type:'question',message:t('Удалить «{name}»?',{name:profile.name}),detail:t('Исходный файл останется на месте.'),buttons:[t('Отмена'),t('Удалить')],cancelId:0,defaultId:0});if(answer.response===1){if(controller.pending.has(id)||(await profiles()).find(p=>p.id===id)?.active||(await profiles()).find(p=>p.id===id)?.statusUnknown)throw Error('Сначала отключите туннель');if(helper.status==='ready')await helperClient.request({op:'forget',id});await fs.unlink(path.join(dir,id+'.conf'));await fs.unlink(path.join(dir,id+'.json'));log('Туннель удалён')}return state()});

 const smartRevision=(config,settings)=>revision(config+JSON.stringify(settings));
 ipcMain.handle('choose-applications',async e=>{
   mainOnly(e);const result=await dialog.showOpenDialog(win,{defaultPath:'/Applications',properties:['openFile','multiSelections'],filters:[{name:'Applications',extensions:['app']}]});
   if(result.canceled)return [];
   const paths=await Promise.all(result.filePaths.map(file=>fs.realpath(file)));
   for(const file of paths){if(!(await fs.stat(path.join(file,'Contents/Info.plist'))).isFile())throw Error('Выберите приложение .app')}
   return validateApps({mode:'off',paths}).paths;
 });
 ipcMain.handle('read-smart-tunneling',async(e,id)=>{
   mainOnly(e);const profile=(await profiles()).find(p=>p.id===id);if(!profile)throw Error('Туннель не найден');
   const config=await fs.readFile(path.join(dir,id+'.conf'),'utf8');const settings=profile.smartTunneling||smartDefaults();
   return {settings,revision:smartRevision(config,settings)};
 });
 ipcMain.handle('save-smart-tunneling',async(e,id,input,expected)=>{
   mainOnly(e);if(editing.has(id)||controller.pending.has(id))throw Error('Дождитесь завершения операции');editing.add(id);
   try{
     const profile=(await profiles()).find(p=>p.id===id);if(!profile)throw Error('Туннель не найден');
     if(profile.active||profile.statusUnknown)throw Error('Сначала отключите этот туннель, затем сохраните изменения');
     const config=await fs.readFile(path.join(dir,id+'.conf'),'utf8');
     if(smartRevision(config,profile.smartTunneling||smartDefaults())!==expected)throw Error('Конфиг изменился. Закройте редактор и откройте заново');
     const applications=validateApps(input?.applications);
     if(appsEnabled(applications)&&input.mode!=='off')throw Error('Выберите правила по адресам или по приложениям');
     const settings={...validateSettingsForSave(config,input),applications};
     if(appsEnabled(applications))compileApps(config,applications);
     const target=path.join(dir,id+'.json');const meta=JSON.parse(await fs.readFile(target,'utf8'));
     const temp=target+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
     try{await fs.writeFile(temp,JSON.stringify({...meta,smartTunneling:settings}),{mode:0o600,flag:'wx'});await fs.rename(temp,target)}finally{await fs.rm(temp,{force:true})}
     return state();
   }finally{editing.delete(id)}
 });
 ipcMain.handle('read-config',async(e,id)=>{mainOnly(e);if(!(await profiles()).some(p=>p.id===id))throw Error('Туннель не найден');const text=await fs.readFile(path.join(dir,id+'.conf'),'utf8');return {text:maskConfig(text),revision:revision(text)}});
 ipcMain.handle('save-config',async(e,id,draft,expected)=>{
   mainOnly(e);if(typeof draft!=='string'||Buffer.byteLength(draft)>65536)throw Error('Конфиг слишком большой');
   if(editing.has(id)||controller.pending.has(id))throw Error('Дождитесь завершения операции');editing.add(id);
   try {
     const profile=(await profiles()).find(p=>p.id===id);if(!profile)throw Error('Туннель не найден');if(profile.active||profile.statusUnknown)throw Error('Сначала отключите этот туннель, затем сохраните изменения');
     const target=path.join(dir,id+'.conf');const original=await fs.readFile(target,'utf8');if(revision(original)!==expected)throw Error('Конфиг изменился. Закройте редактор и откройте заново');
     const text=restoreConfig(draft,original);const summary=parseConfig(text);
     const temp=target+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
     try{await fs.writeFile(temp,text,{mode:0o600,flag:'wx'});await fs.rename(temp,target)}finally{await fs.rm(temp,{force:true})}
     await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({name:profile.name,...summary,smartTunneling:profile.smartTunneling||smartDefaults()}),{mode:0o600});log(profile.name+': конфигурация сохранена');return state();
   }finally{editing.delete(id)}
 });
 ipcMain.handle('open-main',e=>{authorized(e);popover.hide();win.show();win.focus()});
 function secureWindow(window){window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault())}
 function createWindow(){
   win=new BrowserWindow({width:1040,height:720,minWidth:840,minHeight:600,titleBarStyle:'hiddenInset',backgroundColor:'#101416',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
   secureWindow(win);win.loadFile(path.join(__dirname,'../dist/index.html'));
   win.on('close',event=>{if(!quitting){event.preventDefault();win.hide()}});
 }
 function trayIcon(){
   const icon=nativeImage.createFromPath(path.join(__dirname,'../dist/wireguard.png')).resize({width:22,height:22});icon.setTemplateImage(true);return icon;
 }
 createWindow();
 win.webContents.once('did-finish-load',()=>{void markUpdateHealthy(app).catch(error=>log(error.message));if(!updateRolledBack)setTimeout(()=>{void updater.check()},4000)});
 popover=new BrowserWindow({width:360,height:440,show:false,frame:false,resizable:false,skipTaskbar:true,alwaysOnTop:true,backgroundColor:'#101416',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 applyAppearance();secureWindow(popover);popover.loadFile(path.join(__dirname,'../dist/index.html'),{hash:'tray'});popover.on('blur',()=>popover.hide());
 tray=new Tray(trayIcon());tray.setToolTip('WireGuard Desktop');
 const togglePopover=()=>{if(popover.isVisible()){popover.hide();return}const anchor=tray.getBounds();const area=screen.getDisplayNearestPoint({x:anchor.x,y:anchor.y}).workArea;popover.setPosition(Math.max(area.x,Math.min(anchor.x+Math.round(anchor.width/2)-180,area.x+area.width-360)),Math.max(area.y,anchor.y+anchor.height+5));popover.show();popover.focus()};
 tray.on('click',togglePopover);tray.on('right-click',()=>tray.popUpContextMenu(Menu.buildFromTemplate([{label:t('Открыть WireGuard Desktop'),click:()=>{win.show();win.focus()}},{label:t('Завершить приложение (отключить туннели)'),click:()=>app.quit()}])));
 const updateTray=async()=>{publishLocale();try{const all=await profiles();const count=all.filter(p=>p.active).length;tray.setTitle(controller.pending.size?'↻':all.some(p=>p.statusUnknown)?'?':count?String(count):'');tray.setToolTip('WireGuard Desktop · '+t('Активно:')+' '+count+' / '+all.length)}catch{tray.setToolTip('WireGuard Desktop · '+t('Ошибка чтения состояния'))}};
 void setupHelper().then(updateTray);trayTimer=setInterval(updateTray,2500);
 // Quit must bring down active tunnels first: the helper daemon outlives the app.
 app.on('before-quit',event=>{quitting=true;if(trayTimer)clearInterval(trayTimer);if(closing)return;closing=true;event.preventDefault();void shutdownTunnels({profiles,downTunnel:profile=>controller.setActive(profile.id,false),log}).catch(error=>log(error.message)).finally(()=>app.quit())});
 const updateMenu=()=>Menu.setApplicationMenu(Menu.buildFromTemplate([{label:app.name,submenu:[{role:'about',label:t('О программе')},{label:t('Быстрые подключения'),accelerator:'CommandOrControl+Shift+T',click:togglePopover},{role:'quit',label:t('Завершить')}]},{label:t('Правка'),submenu:[{role:'undo',label:t('Отмена')},{role:'redo',label:t('Повторить')},{type:'separator'},{role:'cut',label:t('Вырезать')},{role:'copy',label:t('Копировать')},{role:'paste',label:t('Вставить')},{role:'selectAll',label:t('Выбрать всё')}]}]));refreshLocaleUI=updateMenu;updateMenu();app.on('activate',()=>{publishLocale();win.show();win.focus()});
});
