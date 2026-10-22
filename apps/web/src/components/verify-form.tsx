'use client';
import {useState,useEffect,useRef} from 'react';
import {useForm} from 'react-hook-form';
import {zodResolver} from '@hookform/resolvers/zod';
import {z} from 'zod';
import type {AuthenticityReport,VerifyRequest,ModelSummary} from '@hub/shared';
import {PROTOCOL_LABELS} from '@hub/shared';
import {ShieldCheck,ArrowRight,Key,SpinnerGap} from '@phosphor-icons/react';
import {api} from '@/lib/api/client';
import {API_KEY_LENGTH_ERROR} from '@/lib/api-key';
import {Report} from './authenticity-report';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Card,CardContent} from '@/components/ui/card';
import {Alert,AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from '@/components/ui/select';
import {Form,FormField,FormItem,FormLabel,FormControl,FormDescription,FormMessage} from '@/components/ui/form';
const schema=z.object({baseUrl:z.url('请输入有效的接口地址'),apiKey:z.string().trim().min(8,API_KEY_LENGTH_ERROR).max(500,'API Key 最多 500 位'),model:z.string().trim().min(1,'请输入模型名称'),protocol:z.enum(['openai_chat','openai_responses','anthropic','gemini'])});
export function VerifyForm({models}:{models:ModelSummary[]}){
 const[report,setReport]=useState<AuthenticityReport|null>(null);const[busy,setBusy]=useState(false);const[error,setError]=useState('');const[elapsed,setElapsed]=useState(0);const ctrl=useRef<AbortController|null>(null);
 const form=useForm<VerifyRequest>({resolver:zodResolver(schema),defaultValues:{baseUrl:'',apiKey:'',model:'',protocol:'openai_chat'}});
 useEffect(()=>()=>ctrl.current?.abort(),[]);useEffect(()=>{if(!busy)return;const timer=setInterval(()=>setElapsed(v=>v+1),1000);return()=>clearInterval(timer)},[busy]);
 async function submit(input:VerifyRequest){setBusy(true);setError('');setElapsed(0);setReport(null);const controller=new AbortController();ctrl.current=controller;const timeout=setTimeout(()=>controller.abort(),70000);try{setReport(await api<AuthenticityReport>('/verify',{method:'POST',body:JSON.stringify(input),signal:controller.signal}));form.reset()}catch(err){setError(controller.signal.aborted?'检测超时，请稍后重试。':err instanceof Error?err.message:'检测失败')}finally{clearTimeout(timeout);setBusy(false)}}
 return <div className="verify-layout container"><Card><CardContent className="verify-form"><Form {...form}><form className="space-y-5" onSubmit={form.handleSubmit(submit)}><h2>建立一次真实连接</h2><FormField control={form.control} name="baseUrl" render={({field})=><FormItem><FormLabel>接口地址</FormLabel><FormControl><Input {...field} type="url" placeholder="https://api.example.com"/></FormControl><FormMessage/></FormItem>}/><FormField control={form.control} name="apiKey" render={({field})=><FormItem><FormLabel>检测用 API Key</FormLabel><FormControl><Input {...field} type="password" autoComplete="off" placeholder="sk-…"/></FormControl><FormDescription>建议使用临时、低额度 Key；只用于本次检测。</FormDescription><FormMessage/></FormItem>}/><div className="form-grid"><FormField control={form.control} name="model" render={({field})=><FormItem><FormLabel>模型名称</FormLabel><FormControl><Input {...field} list="verify-models" placeholder="例如 claude-opus-5-5"/></FormControl><datalist id="verify-models">{models.map(model=><option key={model.slug} value={model.slug}>{model.displayName}</option>)}</datalist><FormMessage/></FormItem>}/><FormField control={form.control} name="protocol" render={({field})=><FormItem><FormLabel>API 协议</FormLabel><Select value={field.value} onValueChange={field.onChange}><FormControl><SelectTrigger className="w-full"><SelectValue/></SelectTrigger></FormControl><SelectContent>{Object.entries(PROTOCOL_LABELS).map(([key,label])=><SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select><FormMessage/></FormItem>}/></div>{error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}<Button disabled={busy} type="submit" className="w-full">{busy?<><SpinnerGap className="animate-spin"/>正在检测 · {elapsed}s</>:<>开始鉴定<ArrowRight/></>}</Button><p className="text-[10px]"><Key size={12} className="mr-1 inline"/>Key 不落库、不写日志。每个 IP 每小时最多 10 次，检测最多需要 60 秒，会产生少量 Token 消耗。</p></form></Form></CardContent></Card><Card className="verify-result"><CardContent aria-live="polite">{report?<Report report={report}/>:<div className="verify-idle"><ShieldCheck size={65} weight="thin"/><h3>{busy?'正在交叉验证模型信号':'信任，需要多一点证据。'}</h3><p>{busy?'正在执行连通性、模型回显、协议特征、Token 计数与推理检查。完成后展示逐项依据。':'填入你的接口信息，获取多维度检测报告。每一项判断，都有迹可循。'}</p>{busy&&<Badge className="loading-pulse">检测进行中 · {elapsed}s</Badge>}</div>}</CardContent></Card></div>
}
