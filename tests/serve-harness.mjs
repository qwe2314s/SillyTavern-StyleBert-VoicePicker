import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.mjs':'text/javascript'};
createServer(async(req,res)=>{
  try{
    const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const target=path.resolve(root,`.${requested}`);
    if(!target.startsWith(root+path.sep)||requested.includes('/.git/')){res.writeHead(403);res.end();return}
    res.setHeader('Content-Type',types[path.extname(target)]||'application/octet-stream');
    res.end(await readFile(target));
  }catch{res.writeHead(404);res.end()}
}).listen(8765,'127.0.0.1',()=>console.log('http://127.0.0.1:8765/tests/harness.html'));
