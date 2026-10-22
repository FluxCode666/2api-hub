'use client';
import {ThemeProvider,useTheme} from 'next-themes';
import {useEffect} from 'react';
import {TooltipProvider} from '@/components/ui/tooltip';
import {Toaster} from '@/components/ui/sonner';
import {themes} from '@/lib/theme';

function ThemeMeta(){const{resolvedTheme}=useTheme();useEffect(()=>{const theme=resolvedTheme==='dark'?'dark':'light';document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',themes[theme].background)},[resolvedTheme]);return null}
export function ThemeProviders({children}:{children:React.ReactNode}){return <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey="hub-theme" disableTransitionOnChange><TooltipProvider delayDuration={200}><ThemeMeta/>{children}<Toaster position="bottom-right" closeButton/></TooltipProvider></ThemeProvider>}
