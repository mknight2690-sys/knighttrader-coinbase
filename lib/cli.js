function isElectronArg(arg) {
  return (
    arg.startsWith('--')
    && (
      arg.startsWith('--enable-')
      || arg.startsWith('--disable-')
      || arg.startsWith('--inspect')
      || arg.startsWith('--remote-debugging')
      || arg === '--appimage-extract-and-run'
      || arg.startsWith('--appimage-')
    )
  );
}

function parseCliArgs(argv = process.argv) {
  const out = {
    headless: false,
    paperOnly: false,
    task: '',
    taskFile: '',
    help: false,
  };

  const args = argv.slice(1).filter((arg) => !isElectronArg(arg));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--headless') out.headless = true;
    else if (arg === '--paper-only' || arg === '--paperOnly') out.paperOnly = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--task') out.task = String(args[++i] || '');
    else if (arg === '--task-file' || arg === '--taskFile') out.taskFile = String(args[++i] || '');
  }
  return out;
}

function printHeadlessHelp() {
  const lines = [
    'KnightTrader Propr headless mode',
    '',
    'Usage:',
    '  knighttrader-propr --headless --task "Analyze SOL breakout setup"',
    '  knighttrader-propr --headless --task-file task.txt',
    '  knighttrader-propr --headless --paper-only --task "Backtest only — no orders"',
    '',
    'Environment (optional, no GUI required):',
    '  NOUS_API_KEY or NOUSRESEARCH_API_KEY',
    '  PROPR_API_KEY',
    '  KT_PAPER_ONLY=1',
    '',
    'Config folder:',
    '  ~/.config/knight-trader-propr/hermes-propr/.env',
  ];
  console.log(lines.join('\n'));
}

module.exports = {
  parseCliArgs,
  printHeadlessHelp,
};
