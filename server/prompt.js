export function promptPassword(label) {
  return new Promise(resolve => {
    process.stdout.write(label);
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
        if (char === '\r' || char === '\n') {
          process.stdin.removeListener('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(value); return;
        }
        if (char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ' && value.length < 256) value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
