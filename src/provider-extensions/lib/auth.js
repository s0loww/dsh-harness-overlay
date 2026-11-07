import { join } from 'node:path'

export async function googleLogin({config,env,signal,notify,prompt,load=specifier=>import(specifier)}){
  const [{AntigravityRuntime},{AntigravityAcpConnection}]=await Promise.all([load('pi-antigravity-acp-provider/dist/runtime.js'),load('pi-antigravity-acp-provider/dist/acp/connection.js')])
  const runtime=new AntigravityRuntime(options=>{
    // The SDK's optional headless relay supplies a browser helper/capture path.
    // Preserve those three values without copying its ambient HOME or API keys.
    const relay=Object.fromEntries(['BROWSER','PI_ANTIGRAVITY_OAUTH_CAPTURE_FILE','PATH'].filter(key=>typeof options.env?.[key]==='string').map(key=>[key,options.env[key]]))
    return new AntigravityAcpConnection({...options,cwd:env.HOME,command:config.command,args:config.args,env:Object.keys(relay).length?{...env,...relay}:env})
  },'default')
  try {
    await runtime.loginGoogle(signal,()=>{}, {showAuthorizationUrl:url=>notify({url}),promptForCallback:prompt})
    return {connected:true}
  } finally {await runtime.close()}
}
export async function googleStatus({directory,env,load=specifier=>import(specifier)}){
  const {inspectAntigravityAuth}=await load('pi-antigravity-acp-provider/dist/acp/antigravity.js')
  return {connected:inspectAntigravityAuth(join(directory,'antigravity-acp'),env).status==='oauth-refreshable'}
}
export async function googleLogout({directory,load=specifier=>import(specifier)}){
  const {clearAntigravityCredentials}=await load('pi-antigravity-acp-provider/dist/acp/antigravity.js')
  clearAntigravityCredentials(join(directory,'antigravity-acp'))
}

export async function museAccount({config,env,signal,notify,load=specifier=>import(specifier)}){
  const {spawnMspConnection}=await load('@muse-code/sdk')
  signal?.throwIfAborted()
  const child=spawnMspConnection({command:config.command,args:['serve','--provider','meta','--no-session-log','--disable-write','--disable-shell'],cwd:env.HOME,env,shutdownTimeoutMs:2000})
  const abort=()=>{void child.close()};signal?.addEventListener('abort',abort,{once:true})
  try {
    const host=await child.initialize({clientInfo:{name:'airules-dsh-provider-extensions',version:'0.1.0'},capabilities:{experimentalApi:true}}), connection=host.connection
    if(notify){
      let completed;const wait=new Promise(resolve=>{completed=resolve})
      connection.onNotification(event=>{if(event.method==='account/loginCompleted')completed(event.params)})
      const start=await connection.request('account/loginStart',{type:'deviceCode'})
      notify({url:start.verificationUrl,code:start.userCode})
      const result=await Promise.race([wait,child.exited.then(()=>{throw new Error('MUSE_LOGIN_INTERRUPTED')})])
      signal?.throwIfAborted();if(result.outcome!=='granted')throw new Error('MUSE_LOGIN_REJECTED')
    }
    const account=await connection.request('account/read',{})
    if(account.state!=='accountLogin')return {connected:false,models:[]}
    const catalog=await connection.request('model/list',{})
    return {connected:true,models:(catalog.models??[]).filter(row=>typeof row.modelId==='string').map(row=>({id:row.modelId,name:row.displayLabel??row.modelId}))}
  } finally {signal?.removeEventListener('abort',abort);await child.close()}
}
