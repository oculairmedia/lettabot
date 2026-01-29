#!/usr/bin/env node
/**
 * LettaBot CLI
 * 
 * Commands:
 *   lettabot onboard    - Onboarding workflow (setup integrations, install skills)
 *   lettabot server     - Run the bot server
 *   lettabot configure  - Configure settings
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as readline from 'node:readline';

const args = process.argv.slice(2);
const command = args[0];
const subCommand = args[1];

const ENV_PATH = resolve(process.cwd(), '.env');
const ENV_EXAMPLE_PATH = resolve(process.cwd(), '.env.example');

// Check if value is a placeholder
const isPlaceholder = (val?: string) => !val || /^(your_|sk-\.\.\.|placeholder|example)/i.test(val);

// Simple prompt helper
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Load current env values
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...valueParts] = line.split('=');
      env[key.trim()] = valueParts.join('=').trim();
    }
  }
  return env;
}

// Save env values
function saveEnv(env: Record<string, string>): void {
  // Start with example if no .env exists
  let content = '';
  if (existsSync(ENV_EXAMPLE_PATH)) {
    content = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  }
  
  // Update values
  for (const [key, value] of Object.entries(env)) {
    const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  
  writeFileSync(ENV_PATH, content);
}


// Import onboard from separate module
import { onboard } from './onboard.js';

async function configure() {
  const p = await import('@clack/prompts');
  
  p.intro('🤖 LettaBot Configuration');

  const env = loadEnv();
  
  // Check both .env file and shell environment, filtering placeholders
  const checkVar = (key: string) => {
    const fileValue = env[key];
    const envValue = process.env[key];
    const value = fileValue || envValue;
    return isPlaceholder(value) ? undefined : value;
  };
  
  const configRows = [
    ['LETTA_API_KEY', checkVar('LETTA_API_KEY') ? '✓ Set' : '✗ Not set'],
    ['TELEGRAM_BOT_TOKEN', checkVar('TELEGRAM_BOT_TOKEN') ? '✓ Set' : '✗ Not set'],
    ['SLACK_BOT_TOKEN', checkVar('SLACK_BOT_TOKEN') ? '✓ Set' : '✗ Not set'],
    ['SLACK_APP_TOKEN', checkVar('SLACK_APP_TOKEN') ? '✓ Set' : '✗ Not set'],
    ['HEARTBEAT_INTERVAL_MIN', checkVar('HEARTBEAT_INTERVAL_MIN') || 'Not set'],
    ['CRON_ENABLED', checkVar('CRON_ENABLED') || 'false'],
    ['WORKING_DIR', checkVar('WORKING_DIR') || '/tmp/lettabot'],
    ['AGENT_NAME', checkVar('AGENT_NAME') || 'LettaBot'],
    ['MODEL', checkVar('MODEL') || '(default)'],
  ];
  
  const maxKeyLength = Math.max(...configRows.map(([key]) => key.length));
  const summary = configRows
    .map(([key, value]) => `${(key + ':').padEnd(maxKeyLength + 1)} ${value}`)
    .join('\n');
  
  p.note(summary, 'Current Configuration');
  
  const choice = await p.select({
    message: 'What would you like to configure?',
    options: [
      { value: '1', label: 'Letta API Key', hint: '' },
      { value: '2', label: 'Telegram', hint: '' },
      { value: '3', label: 'Slack', hint: '' },
      { value: '4', label: 'Heartbeat', hint: '' },
      { value: '5', label: 'Cron', hint: '' },
      { value: '6', label: 'Working Directory', hint: '' },
      { value: '7', label: 'Agent Name & Model', hint: '' },
      { value: '8', label: 'Edit .env directly', hint: '' },
      { value: '9', label: 'Exit', hint: '' },
    ],
  });
  
  if (p.isCancel(choice)) {
    p.cancel('Configuration cancelled');
    return;
  }
  
  switch (choice) {
    case '1':
      env.LETTA_API_KEY = await prompt('Enter Letta API Key: ');
      saveEnv(env);
      console.log('✓ Saved');
      break;
    case '2':
      env.TELEGRAM_BOT_TOKEN = await prompt('Enter Telegram Bot Token: ');
      saveEnv(env);
      console.log('✓ Saved');
      break;
    case '3':
      env.SLACK_BOT_TOKEN = await prompt('Enter Slack Bot Token: ');
      env.SLACK_APP_TOKEN = await prompt('Enter Slack App Token: ');
      saveEnv(env);
      console.log('✓ Saved');
      break;
    case '4':
      env.HEARTBEAT_INTERVAL_MIN = await prompt('Heartbeat interval (minutes, 0 to disable): ');
      saveEnv(env);
      console.log('✓ Saved');
      break;
    case '5':
      env.CRON_ENABLED = (await prompt('Enable cron? (y/n): ')).toLowerCase() === 'y' ? 'true' : 'false';
      saveEnv(env);
      console.log('✓ Saved');
      break;
    case '6':
      env.WORKING_DIR = await prompt('Working directory: ');
      saveEnv(env);
      console.log('✓ Saved');
      break;
    case '7': {
      const p = await import('@clack/prompts');
      const { buildModelOptions, handleModelSelection } = await import('./utils/model-selection.js');
      
      const currentName = env.AGENT_NAME || 'LettaBot';
      const name = await p.text({
        message: 'Agent name',
        placeholder: currentName,
        initialValue: currentName,
      });
      if (!p.isCancel(name) && name) env.AGENT_NAME = name;
      
      const currentModel = env.MODEL || 'default';
      p.log.info(`Current model: ${currentModel}\n`);
      
      const spinner = p.spinner();
      spinner.start('Fetching available models...');
      const modelOptions = await buildModelOptions();
      spinner.stop('Models loaded');
      
      const modelChoice = await p.select({
        message: 'Select model',
        options: modelOptions,
        maxItems: 10,
      });
      
      if (!p.isCancel(modelChoice)) {
        const selectedModel = await handleModelSelection(modelChoice, p.text);
        if (selectedModel) {
          env.MODEL = selectedModel;
        }
      }
      
      saveEnv(env);
      p.log.success('Saved');
      break;
    }
    case '8':
      const editor = process.env.EDITOR || 'nano';
      spawnSync(editor, [ENV_PATH], { stdio: 'inherit' });
      break;
    case '9':
      return;
    default:
      console.log('Invalid choice');
  }
}

async function server() {
  // Check if configured
  if (!existsSync(ENV_PATH)) {
    console.log('No .env found. Run "lettabot onboard" first.\n');
    process.exit(1);
  }
  
  console.log('Starting LettaBot server...\n');
  
  // Start the bot using the compiled JS
  const mainPath = resolve(process.cwd(), 'dist/main.js');
  if (existsSync(mainPath)) {
    spawn('node', [mainPath], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env },
    });
  } else {
    // Fallback to tsx for development
    const mainTsPath = new URL('./main.ts', import.meta.url).pathname;
    spawn('npx', ['tsx', mainTsPath], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  }
}

// Pairing commands
async function pairingList(channel: string) {
  const { listPairingRequests } = await import('./pairing/store.js');
  const requests = await listPairingRequests(channel);
  
  if (requests.length === 0) {
    console.log(`No pending ${channel} pairing requests.`);
    return;
  }
  
  console.log(`\nPending ${channel} pairing requests (${requests.length}):\n`);
  console.log('  Code      | User ID           | Username          | Requested');
  console.log('  ----------|-------------------|-------------------|---------------------');
  
  for (const r of requests) {
    const username = r.meta?.username ? `@${r.meta.username}` : r.meta?.firstName || '-';
    const date = new Date(r.createdAt).toLocaleString();
    console.log(`  ${r.code.padEnd(10)}| ${r.id.padEnd(18)}| ${username.padEnd(18)}| ${date}`);
  }
  console.log('');
}

async function pairingApprove(channel: string, code: string) {
  const { approvePairingCode } = await import('./pairing/store.js');
  const result = await approvePairingCode(channel, code);
  
  if (!result) {
    console.log(`No pending pairing request found for code: ${code}`);
    process.exit(1);
  }
  
  const name = result.meta?.username ? `@${result.meta.username}` : result.meta?.firstName || result.userId;
  console.log(`✓ Approved ${channel} sender: ${name} (${result.userId})`);
}

function showHelp() {
  console.log(`
LettaBot - Multi-channel AI assistant with persistent memory

Usage: lettabot <command>

Commands:
  onboard              Setup wizard (integrations, skills, configuration)
  server               Start the bot server
  configure            View and edit configuration
  logout               Logout from Letta Platform (revoke OAuth tokens)
  skills               Configure which skills are enabled
  skills status        Show skills status
  destroy              Delete all local data and start fresh
  pairing list <ch>    List pending pairing requests
  pairing approve <ch> <code>   Approve a pairing code
  help                 Show this help message

Examples:
  lettabot onboard                           # First-time setup
  lettabot server                            # Start the bot
  lettabot pairing list telegram             # Show pending Telegram pairings
  lettabot pairing approve telegram ABCD1234 # Approve a pairing code

Environment:
  LETTA_API_KEY           API key from app.letta.com
  TELEGRAM_BOT_TOKEN      Bot token from @BotFather
  TELEGRAM_DM_POLICY      DM access policy (pairing, allowlist, open)
  SLACK_BOT_TOKEN         Slack bot token (xoxb-...)
  SLACK_APP_TOKEN         Slack app token (xapp-...)
  HEARTBEAT_INTERVAL_MIN  Heartbeat interval in minutes
  CRON_ENABLED            Enable cron jobs (true/false)
`);
}

async function main() {
  switch (command) {
    case 'onboard':
    case 'setup':
    case 'init':
      await onboard();
      break;
      
    case 'server':
    case 'start':
    case 'run':
      await server();
      break;
      
    case 'configure':
    case 'config':
      await configure();
      break;
      
    case 'skills': {
      const { showStatus, runSkillsSync } = await import('./skills/index.js');
      switch (subCommand) {
        case 'status':
          await showStatus();
          break;
        default:
          await runSkillsSync();
      }
      break;
    }
    
    case 'pairing': {
      const channel = subCommand;
      const action = args[2];
      
      if (!channel) {
        console.log('Usage: lettabot pairing <list|approve> <channel> [code]');
        console.log('Example: lettabot pairing list telegram');
        console.log('Example: lettabot pairing approve telegram ABCD1234');
        process.exit(1);
      }
      
      // Support both "pairing list telegram" and "pairing telegram list"
      if (channel === 'list' || channel === 'ls') {
        const ch = action || args[3];
        if (!ch) {
          console.log('Usage: lettabot pairing list <channel>');
          process.exit(1);
        }
        await pairingList(ch);
      } else if (channel === 'approve') {
        const ch = action;
        const code = args[3];
        if (!ch || !code) {
          console.log('Usage: lettabot pairing approve <channel> <code>');
          process.exit(1);
        }
        await pairingApprove(ch, code);
      } else if (action === 'list' || action === 'ls') {
        await pairingList(channel);
      } else if (action === 'approve') {
        const code = args[3];
        if (!code) {
          console.log('Usage: lettabot pairing approve <channel> <code>');
          process.exit(1);
        }
        await pairingApprove(channel, code);
      } else if (action) {
        // Assume "lettabot pairing telegram ABCD1234" means approve
        await pairingApprove(channel, action);
      } else {
        await pairingList(channel);
      }
      break;
    }
      
    case 'destroy': {
      const { rmSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const p = await import('@clack/prompts');
      
      const workingDir = process.env.WORKING_DIR || '/tmp/lettabot';
      // Agent store is in cwd, not working dir
      const agentJsonPath = join(process.cwd(), 'lettabot-agent.json');
      const skillsDir = join(workingDir, '.skills');
      const cronJobsPath = join(workingDir, 'cron-jobs.json');
      
      p.intro('🗑️  Destroy LettaBot Data');
      
      p.log.warn('This will delete:');
      p.log.message(`  • Agent store: ${agentJsonPath}`);
      p.log.message(`  • Skills: ${skillsDir}`);
      p.log.message(`  • Cron jobs: ${cronJobsPath}`);
      p.log.message('');
      p.log.message('Note: The agent on Letta servers will NOT be deleted.');
      
      const confirmed = await p.confirm({
        message: 'Are you sure you want to destroy all local data?',
        initialValue: false,
      });
      
      if (!confirmed || p.isCancel(confirmed)) {
        p.cancel('Cancelled');
        break;
      }
      
      // Delete files
      let deleted = 0;
      
      if (existsSync(agentJsonPath)) {
        rmSync(agentJsonPath);
        p.log.success('Deleted lettabot-agent.json');
        deleted++;
      }
      
      if (existsSync(skillsDir)) {
        rmSync(skillsDir, { recursive: true });
        p.log.success('Deleted .skills/');
        deleted++;
      }
      
      if (existsSync(cronJobsPath)) {
        rmSync(cronJobsPath);
        p.log.success('Deleted cron-jobs.json');
        deleted++;
      }
      
      if (deleted === 0) {
        p.log.info('Nothing to delete');
      }
      
      p.outro('✨ Done! Run `lettabot server` to create a fresh agent.');
      break;
    }
      
    case 'logout': {
      const { revokeToken } = await import('./auth/oauth.js');
      const { loadTokens, deleteTokens } = await import('./auth/tokens.js');
      const p = await import('@clack/prompts');
      
      p.intro('Logout from Letta Platform');
      
      const tokens = loadTokens();
      if (!tokens) {
        p.log.info('No stored credentials found.');
        break;
      }
      
      const spinner = p.spinner();
      spinner.start('Revoking token...');
      
      // Revoke the refresh token on the server
      if (tokens.refreshToken) {
        await revokeToken(tokens.refreshToken);
      }
      
      // Delete local tokens
      deleteTokens();
      
      spinner.stop('Logged out successfully');
      p.log.info('Note: LETTA_API_KEY in .env was not modified. Remove it manually if needed.');
      p.outro('Goodbye!');
      break;
    }
      
    case 'help':
    case '-h':
    case '--help':
      showHelp();
      break;
      
    case undefined:
      console.log('Usage: lettabot <command>\n');
      console.log('Commands: onboard, server, configure, skills, destroy, help\n');
      console.log('Run "lettabot help" for more information.');
      break;
      
    default:
      console.log(`Unknown command: ${command}`);
      console.log('Run "lettabot help" for usage.');
      process.exit(1);
  }
}

main().catch(console.error);
