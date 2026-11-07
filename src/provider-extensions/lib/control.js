import {randomBytes,timingSafeEqual} from 'node:crypto'
export const CONTROL_PATH='/airules/provider-drivers'
const PUBLIC_ERRORS=new Set(['DRIVER_REJECTED','DRIVER_CONFIG_INVALID','DRIVER_EXECUTABLE_REQUIRED','DRIVER_DIGEST_REQUIRED','DRIVER_ARGUMENTS_INVALID','DRIVER_EXECUTABLE_REJECTED','DRIVER_DIGEST_MISMATCH','DRIVER_HOME_REQUIRED','DRIVER_HOME_REJECTED','DRIVER_LOCAL_ACL_FAILED','DRIVER_ACP_REGISTRY_REQUIRED','DRIVER_SETUP_REQUIRED','DRIVER_INPUT_REJECTED','DRIVER_ACTION_REJECTED','DRIVER_BUSY','DRIVER_CALLBACK_REJECTED','DRIVER_LOGIN_REQUIRED','DRIVER_CONTROLLER_CLOSED','DRIVER_MANIFEST_INVALID'])
export function createDriverHandler(controller,{connection,token=randomBytes(32).toString('base64url')}={}){
  return async(request,response)=>{
    const send=(status,value)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value))}
    if(!connection||connection.requestRejection(request)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
    if(!['GET','POST'].includes(request.method))return send(405,{ok:false,error:'METHOD_REJECTED'})
    try {
      if(request.method==='POST'){
        const given=Buffer.from(String(request.headers?.['x-dsh-csrf']??'')),expected=Buffer.from(token)
        if(given.length!==expected.length||!timingSafeEqual(given,expected))return send(403,{ok:false,error:'CSRF_REQUIRED'})
        if(!String(request.headers?.['content-type']??'').startsWith('application/json'))throw new Error('INPUT')
        const chunks=[];let size=0;for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>12288)throw new Error('LIMIT');chunks.push(bytes)}
        await controller.action(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      return send(200,{ok:true,...await controller.snapshot(),csrfToken:token})
    } catch(error){const code=PUBLIC_ERRORS.has(error.message)?error.message:'DRIVER_OPERATION_FAILED';return send(400,{ok:false,error:code})}
  }
}
