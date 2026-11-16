import { spawn } from 'node:child_process';

export async function nodeApi() {
  const child = spawn(
    'node',
    [
      '-e',
      `
    const {NestFactory}=require('@nestjs/core'); const {ValidationPipe}=require('@nestjs/common');
    const {AppModule}=require('./dist/app.module');
    (async()=>{const app=await NestFactory.create(AppModule,{logger:false});
      app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));
      await app.listen(0,'127.0.0.1'); console.log(app.getHttpServer().address().port);
      process.on('SIGTERM',async()=>{await app.close();process.exit(0);});
    })().catch(()=>process.exit(1));
  `,
    ],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('NODE_API_STARTUP_TIMEOUT')), 15000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('NODE_API_EXITED'));
      });
      child.stdout.once('data', (data: Buffer) => {
        clearTimeout(timer);
        const port = Number(data.toString().trim());
        if (!Number.isInteger(port) || port < 1) reject(new Error('INVALID_NODE_API_PORT'));
        else resolve(port);
      });
    });
    return { url: `http://127.0.0.1:${port}`, pid: child.pid, close };
  } catch (error) {
    await close();
    throw error;
  }
}
