import { randomBytes,timingSafeEqual } from 'node:crypto'
export const PLAN_CONTROL_PATH='/airules/additional-provider-plans'
export function createPlanHandler(controller,{connection,token=randomBytes(32).toString('base64url')}={}) {
  return async(request,response)=>{
    const send=(status,data)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(data))}
    if(!connection||connection.requestRejection(request)!==undefined)return send(403,{ok:false,error:'NATIVE_CONNECTION_REQUIRED'})
    if(!['GET','POST'].includes(request.method))return send(405,{ok:false,error:'METHOD_REJECTED'})
    try {
      if(request.method==='POST') {
        const supplied=Buffer.from(String(request.headers?.['x-dsh-csrf']??'')), expected=Buffer.from(token)
        if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{ok:false,error:'CSRF_REQUIRED'})
        if(!String(request.headers?.['content-type']??'').startsWith('application/json'))throw new Error('PLAN_FIELDS_REJECTED')
        let size=0;const chunks=[]
        for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>8192)throw new Error('PLAN_BODY_LIMIT');chunks.push(bytes)}
        await controller.action(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
      return send(200,{ok:true,...await controller.snapshot(),csrfToken:token})
    } catch(error) {
      const code=['PLAN_FIELDS_REJECTED','PLAN_ACTION_REJECTED','PLAN_KEY_INVALID','PLAN_PROVIDER_REJECTED','PLAN_PROVIDER_UNAVAILABLE','PLAN_STALE','PLAN_BODY_LIMIT'].includes(error.message)?error.message:'PLAN_ACTION_FAILED'
      send(code==='PLAN_STALE'?409:400,{ok:false,error:code})
    }
  }
}
