"""Local, serialized Style-Bert-VITS2 2.7 API with checkpoint and pitch controls.
No training, source edits, or eager Japanese BERT preload is performed.
"""
import argparse
import asyncio
from io import BytesIO
import os
from pathlib import Path
import re
import sys
import threading

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field, ValidationError

class VoiceRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    model_name: str | None = None
    model_id: int = Field(default=0, ge=0)
    speaker_name: str | None = None
    speaker_id: int = Field(default=0, ge=0)
    checkpoint: str | None = None
    language: str = 'ZH'
    style: str = 'Neutral'
    style_weight: float = Field(default=1, ge=0, le=3)
    sdp_ratio: float = Field(default=.2, ge=0, le=1)
    noise: float = Field(default=.6, ge=.1, le=2)
    noisew: float = Field(default=.8, ge=.1, le=2)
    length: float = Field(default=1, ge=.5, le=2)
    auto_split: bool = True
    split_interval: float = Field(default=.5, ge=0, le=2)
    assist_text: str | None = Field(default=None, max_length=160)
    assist_text_weight: float = Field(default=.3, ge=0, le=1)
    pitch_scale: float = Field(default=1, ge=.8, le=1.5)
    intonation_scale: float = Field(default=1, ge=0, le=2)

def checkpoint_order(path):
    match=re.search(r'_s(\d+)',path.stem)
    return (int(match[1]) if match else -1,path.stat().st_mtime,path.name)

class SBVEngine:
    def __init__(self, repo, models_dir=None, device='cuda'):
        repo=Path(repo).resolve()
        if not (repo/'style_bert_vits2'/'tts_model.py').is_file():
            raise ValueError('无效的 Style-Bert-VITS2 程序目录')
        sys.path.insert(0,str(repo))
        if Path.cwd().resolve()!=repo: os.chdir(repo)
        import torch
        from style_bert_vits2.tts_model import TTSModel, TTSModelHolder
        from style_bert_vits2.utils import torch_device_to_onnx_providers
        self.model_class=TTSModel
        self.device='cuda' if device=='cuda' and torch.cuda.is_available() else 'cpu'
        self.holder=TTSModelHolder(Path(models_dir or repo/'model_assets'),self.device,torch_device_to_onnx_providers(self.device),ignore_onnx=True)
        self.lock=threading.Lock();self.current=None;self.current_key=None

    def info(self, refresh=False):
        with self.lock:
            if refresh:
                self.holder.refresh()
                if self.current: self.current.unload()
                self.current=None;self.current_key=None
            result={}
            import json
            for index,name in enumerate(self.holder.model_names):
                directory=self.holder.root_dir/name
                config=json.loads((directory/'config.json').read_text(encoding='utf-8'))
                checkpoints=sorted(self.holder.model_files_dict[name],key=checkpoint_order,reverse=True)
                if not checkpoints: continue
                result[str(index)]={'model_name':name,'config_path':str(directory/'config.json'),
                    'model_path':str(checkpoints[0]),'device':self.device,'spk2id':config['data']['spk2id'],
                    'style2id':config['data']['style2id'],'checkpoints':[p.name for p in checkpoints],
                    'default_checkpoint':checkpoints[0].name}
            return result

    def synthesize(self, params):
        catalog=self.info()
        model=next((item for item in catalog.values() if item['model_name']==params.model_name),None) if params.model_name else catalog.get(str(params.model_id))
        if not model: raise ValueError('模型不存在，请刷新模型列表')
        if params.language not in ['ZH','JP','EN']: raise ValueError('语言必须是 ZH JP EN')
        if params.style not in model['style2id']: raise ValueError('该模型没有这个情绪风格')
        speaker=model['spk2id'].get(params.speaker_name) if params.speaker_name else params.speaker_id
        if speaker not in model['spk2id'].values(): raise ValueError('该模型没有这个说话人')
        checkpoint=params.checkpoint or model['default_checkpoint']
        if checkpoint not in model['checkpoints']: raise ValueError('检查点不存在，请重新选择模型文件')
        directory=Path(model['config_path']).parent
        with self.lock:
            key=(model['model_name'],checkpoint)
            if key!=self.current_key:
                if self.current: self.current.unload()
                self.current=None;self.current_key=None
                self.current=self.model_class(directory/checkpoint,directory/'config.json',directory/'style_vectors.npy',self.device)
                self.current_key=key
            sr,audio=self.current.infer(text=params.text,language=params.language,speaker_id=speaker,
                style=params.style,style_weight=params.style_weight,sdp_ratio=params.sdp_ratio,
                noise=params.noise,noise_w=params.noisew,length=params.length,line_split=params.auto_split,
                split_interval=params.split_interval,assist_text=params.assist_text,
                assist_text_weight=params.assist_text_weight,use_assist_text=bool(params.assist_text),
                pitch_scale=params.pitch_scale,intonation_scale=params.intonation_scale)
        from scipy.io import wavfile
        buffer=BytesIO();wavfile.write(buffer,sr,audio)
        return buffer.getvalue()

def create_app(engine, origins):
    app=FastAPI(title='Style-Bert Voice Picker local API',version='0.2.0')
    app.add_middleware(CORSMiddleware,allow_origins=origins,allow_methods=['GET','POST'],allow_headers=['Content-Type'])

    @app.get('/capabilities')
    def capabilities():
        return {'api':'sbvp','version':'0.2.0','checkpoint_selection':True,'text_limit':500,
            'parameters':list(getattr(VoiceRequest,'model_fields',None) or VoiceRequest.__fields__)}

    @app.get('/models/info')
    async def models(): return await asyncio.to_thread(engine.info)

    @app.post('/models/refresh')
    async def refresh(): return await asyncio.to_thread(engine.info,True)

    @app.post('/voice')
    async def voice(request: Request):
        payload=dict(request.query_params)
        if request.headers.get('content-type','').split(';')[0]=='application/json':
            if await request.body():
                try: body=await request.json()
                except ValueError as error: raise HTTPException(422,'无效的 JSON 请求') from error
                if not isinstance(body,dict): raise HTTPException(422,'请求必须是 JSON 对象')
                payload.update(body)
        try:
            params=VoiceRequest(**payload)
            result=await asyncio.to_thread(engine.synthesize,params)
        except ValidationError as error:
            raise HTTPException(422,detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(422,detail=str(error)) from error
        except Exception as error:
            print(f'合成失败: {type(error).__name__}: {error}',file=sys.stderr)
            raise HTTPException(500,'本机合成失败，请查看 API 窗口的详细错误；显存不足时关闭其他已加载的模型。') from error
        return Response(result,media_type='audio/wav')
    return app

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sbv2-dir',type=Path,default=Path(r'E:\sbv2\Style-Bert-VITS2'))
    parser.add_argument('--models-dir',type=Path)
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=5000)
    parser.add_argument('--device',choices=['cuda','cpu'],default='cuda')
    parser.add_argument('--allow-origin',action='append',default=[])
    args=parser.parse_args()
    origins=args.allow_origin or ['http://127.0.0.1:8000','http://localhost:8000','http://127.0.0.1:8124','http://localhost:8124']
    engine=SBVEngine(args.sbv2_dir,args.models_dir,args.device)
    import uvicorn
    uvicorn.run(create_app(engine,origins),host=args.host,port=args.port)

if __name__=='__main__': main()
