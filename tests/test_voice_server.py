import asyncio
import importlib.util
from pathlib import Path
import unittest

import httpx

spec=importlib.util.spec_from_file_location('voice_server',Path(__file__).parents[1]/'tools'/'voice_server.py')
server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)

class FakeEngine:
    def __init__(self): self.calls=[]
    def info(self,refresh=False): return {'0':{'model_name':'test','spk2id':{'test':0},'style2id':{'Normal':0}}}
    def synthesize(self,params): self.calls.append(params);return b'RIFFtest'

class APITest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine=FakeEngine()
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=server.create_app(self.engine,['http://localhost:8000'])),base_url='http://test')
    async def asyncTearDown(self): await self.client.aclose()
    async def test_query_and_json_controls_reach_engine(self):
        response=await self.client.post('/voice',params={'text':'你好','style':'Normal','pitch_scale':1.1,'intonation_scale':.9,'noisew':.4,'auto_split':'false'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers['content-type'],'audio/wav')
        p=self.engine.calls[-1]
        self.assertEqual((p.pitch_scale,p.intonation_scale,p.noisew,p.auto_split),(1.1,.9,.4,False))
        response=await self.client.post('/voice',json={'text':'再见','checkpoint':'sample_s1000.safetensors','assist_text':'好开心！','assist_text_weight':.2})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.engine.calls[-1].checkpoint,'sample_s1000.safetensors')
    async def test_bounds_and_bad_requests_do_not_run_inference(self):
        for payload in [{'text':''},{'text':'字'*501},{'text':'你好','pitch_scale':8},{'text':'你好','noise':-1}]:
            response=await self.client.post('/voice',json=payload)
            self.assertEqual(response.status_code,422)
        self.assertEqual(self.engine.calls,[])
        self.assertEqual((await self.client.post('/voice',content='{',headers={'content-type':'application/json'})).status_code,422)
    async def test_capabilities_and_cors(self):
        caps=(await self.client.get('/capabilities')).json()
        self.assertIn('pitch_scale',caps['parameters'])
        self.assertTrue(caps['checkpoint_selection'])
        allowed=await self.client.options('/voice',headers={'Origin':'http://localhost:8000','Access-Control-Request-Method':'POST'})
        self.assertEqual(allowed.headers.get('access-control-allow-origin'),'http://localhost:8000')
        denied=await self.client.options('/voice',headers={'Origin':'https://example.com','Access-Control-Request-Method':'POST'})
        self.assertNotIn('access-control-allow-origin',denied.headers)

if __name__=='__main__': unittest.main()
