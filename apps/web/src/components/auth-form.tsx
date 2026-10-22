'use client';
import Link from 'next/link';
import {useState} from 'react';
import {useForm} from 'react-hook-form';
import {z} from 'zod';
import {zodResolver} from '@hookform/resolvers/zod';
import type {SessionUser,RegisterInput,LoginInput} from '@hub/shared';
import {ArrowRight} from '@phosphor-icons/react';
import {api} from '@/lib/api/client';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Alert,AlertDescription} from '@/components/ui/alert';
import {Form,FormField,FormItem,FormLabel,FormControl,FormMessage} from '@/components/ui/form';
const schema=z.object({email:z.email('请输入有效邮箱'),password:z.string().min(8,'密码长度至少 8 位').max(100,'密码最多 100 位'),nickname:z.string().max(40,'昵称最多 40 个字').optional()});
export function AuthForm({register=false,next='/me'}:{register?:boolean;next?:string}){
 const[error,setError]=useState('');const[busy,setBusy]=useState(false);const destination=next.startsWith('/')&&!next.startsWith('//')&&!next.includes('\\')?next:'/me';
 const form=useForm<RegisterInput>({resolver:zodResolver(schema),defaultValues:{email:'',password:'',nickname:''}});
 async function submit(values:RegisterInput){setBusy(true);setError('');const body:LoginInput|RegisterInput={email:values.email.trim(),password:values.password,...(register&&values.nickname?.trim()?{nickname:values.nickname.trim()}: {})};try{await api<SessionUser>(`/auth/${register?'register':'login'}`,{method:'POST',body:JSON.stringify(body)});window.location.assign(destination)}catch(err){setError(err instanceof Error?err.message:'暂时无法登录，请稍后重试。');setBusy(false)}}
 return <><Form {...form}><form className="space-y-5" onSubmit={form.handleSubmit(submit)}>{register&&<FormField control={form.control} name="nickname" render={({field})=><FormItem><FormLabel>怎么称呼你</FormLabel><FormControl><Input {...field} autoComplete="nickname" placeholder="你的昵称"/></FormControl><FormMessage/></FormItem>}/>}<FormField control={form.control} name="email" render={({field})=><FormItem><FormLabel>邮箱地址</FormLabel><FormControl><Input {...field} type="email" autoComplete="email" placeholder="you@example.com"/></FormControl><FormMessage/></FormItem>}/><FormField control={form.control} name="password" render={({field})=><FormItem><FormLabel>密码</FormLabel><FormControl><Input {...field} type="password" autoComplete={register?'new-password':'current-password'} placeholder={register?'至少 8 位字符':'输入你的密码'}/></FormControl><FormMessage/></FormItem>}/>{error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}<Button className="w-full" type="submit" disabled={busy}>{busy?'正在连接…':register?'创建账号':'登录'}<ArrowRight/></Button></form></Form><p className="auth-bottom">{register?'已经有账号？':'还没有账号？'} <Button asChild variant="link"><Link href={`${register?'/login':'/register'}?next=${encodeURIComponent(destination)}`}>{register?'去登录':'注册一个'}</Link></Button></p></>
}
