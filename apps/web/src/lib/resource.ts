import {notFound} from 'next/navigation';
import {serverApi,ApiRequestError} from '@/lib/api/server';
import {publicApi} from '@/lib/api/public';
export async function resource<T>(path:string){try{return await serverApi<T>(path)}catch(e){if(e instanceof ApiRequestError&&e.status===404)notFound();throw e}}
export async function publicResource<T>(path:string,revalidate=60){try{return await publicApi<T>(path,revalidate)}catch(e){if(e instanceof ApiRequestError&&e.status===404)notFound();throw e}}
