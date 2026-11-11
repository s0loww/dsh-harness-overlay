import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {renderInstalledLauncher} from '../src/deployment-bundle/cli.mjs'
test('actual Windows launcher starts from CP866 and preserves Cyrillic paths, spaces and literal percent signs',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-launch-unicode-')),folder=join(root,'Капитан Дизель'),output=join(root,'args.json');await mkdir(folder)
 const cliPath=join(folder,'проверка.mjs'),wrapper=join(folder,'wrapper.cmd'),launcher=join(folder,'LaunchDSH.cmd')
 await writeFile(cliPath,"import{writeFileSync}from'node:fs';writeFileSync(process.env.DSH_LAUNCH_TEST_OUTPUT,JSON.stringify(process.argv.slice(2)),'utf8')")
 const settings={nodePath:process.execPath,cliPath,bundleRoot:join(folder,'пакет'),stateRoot:join(folder,'состояние'),installRoot:join(folder,'установка'),dshHome:join(folder,'дом %ПРОБА%'),isolatedRoot:folder}
 await writeFile(launcher,renderInstalledLauncher(settings));await writeFile(wrapper,'@echo off\r\nchcp 866 >nul\r\ncall "%~dp0LaunchDSH.cmd"\r\n')
 await promisify(execFile)('cmd.exe',['/d','/s','/c','wrapper.cmd'],{cwd:folder,env:{...process.env,DSH_LAUNCH_TEST_OUTPUT:output},windowsHide:true,timeout:15000})
 const args=JSON.parse(await readFile(output,'utf8'));assert.equal(args[0],'launch');assert.equal(args[args.indexOf('--dsh-home')+1],settings.dshHome);assert.equal(args[args.indexOf('--install-root')+1],settings.installRoot);assert.equal(args[args.indexOf('--isolated-root')+1],folder)
})
