import {randomBytes,timingSafeEqual}from'node:crypto'
export const CONTROL_PATH='/airules/cursor-provider'
export function createHandler(controller,{connection,token=randomBytes(32).toString('base64url')}={}){
  return async(request,response)=>{
    const send=(status,body)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(body))}
    if(!connection||connection.requestRejection(request)!==undefined)return send(403,{ok:false})
    if(!['GET','POST'].includes(request.method))return send(405,{ok:false})
    try{if(request.method==='POST'){
      const supplied=Buffer.from(String(request.headers?.['x-dsh-csrf']??'')),expected=Buffer.from(token)
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{ok:false})
      let size=0;const chunks=[];for await(const chunk of request){size+=Buffer.byteLength(chunk);if(size>8192)throw new Error();chunks.push(Buffer.from(chunk))}
      await controller.action(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    }send(200,{ok:true,...await controller.snapshot(),csrfToken:token})}catch{send(400,{ok:false,error:'CURSOR_ACTION_FAILED'})}
  }
}
