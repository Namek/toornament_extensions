require('dotenv-flow').config();
const colors = require('colors/safe');
const fs = require('fs');
const paths = require('path');
const { chromium } = require('playwright');
const yargs = require('yargs');

import type { Browser, Page, BrowserContext } from 'playwright';

const tournamentId = process.env.TOURNAMENT_ID;

if (!process.env.ACCOUNT_USERNAME || !process.env.ACCOUNT_PASSWORD || !tournamentId) {
  throw new Error('Please make sure the .env.local file exists and contains all credentials.');
}

const datetimePattern = /^\d\d\d\d\-\d\d\-\d\d([T ]\d\d?(:\d\d)?)?$/;
const datetimeErrorMessage = 'Datetime in format: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` or empty value to check from beginning.';


const state = {
  paused: false,
  browser: null as Browser,
  browserContext: null as BrowserContext,
  browserPages: [] as Page[],
};

process.stdin.resume(); // so it doesn't ask whether it should terminate job on CTRL+C

async function exitHandler(options, exitCode) {
  for (const page of state.browserPages) {
    await page.close();
  }
  state.browserPages.length = 0;
  await state.browserContext?.close();
  if (state.browser) await state.browser.close();
}

process.on('uncaughtException', exitHandler.bind(null, {exit:true}));
process.on('unhandledRejection', exitHandler.bind(null, {exit:true}));

//do something when app is closing
process.on('exit', exitHandler.bind(null,{cleanup:true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {exit:true}));
process.on('SIGUSR2', exitHandler.bind(null, {exit:true}));


(async () => {
  const argv = yargs
    .option('since', {
      type: 'string',
      describe: 'Since when should I report new messages in Lobbies?'
    })
    .option('headless', {
      type: 'boolean',
      describe: 'should I show you the browser?',
      default: true,
    })
    .option('new-msg-output-file', {
      type: 'string',
      describe: 'path to file where lobbies with new messages should be saved to',
    })
    .option('all-msg-output-file', {
      type: 'string',
      describe: 'path to file where lobbies with ALL messages should be saved to',
    })
    .option('pause-on-new-messages-for', {
      type: 'number',
      describe: 'number of seconds to automatically pause on current lobby when it contains new messages',
    })
    .check(argv => {
      if (argv.since && !datetimePattern.exec(argv.since)) {
        throw new Error('--since argument: ' + datetimeErrorMessage);
      }

      if (argv.newMsgOutputFile) {
        const { canSave, normalizedPath } = testFileSave(argv.newMsgOutputFile);
        if (!canSave) {
          throw new Error('The given file path for new messages is not writeable: ' + normalizedPath);
        }
        argv.newMsgOutputFile = normalizedPath;
      }

      if (argv.allMsgOutputFile) {
        const { canSave, normalizedPath } = testFileSave(argv.allMsgOutputFile);
        if (!canSave) {
          throw new Error('The given file path for all messages is not writeable: ' + normalizedPath);
        }
        argv.allMsgOutputFile = normalizedPath;
      }

      return true;
    })
    .help()
    .showHelp()
    .argv;

  const sinceDatetime = argv.since ? new Date(argv.since) : null;

  state.browser = await chromium.launch({
    headless: argv.headless,
  });
  state.browserContext = await state.browser.newContext();
  const page = await state.browserContext.newPage();
  state.browserPages.push(page);

  async function visitLobby(match) {
    await page.goto(`${match.url}lobby`);
    await page.waitForSelector('section.content .card-content .grid-flex .loader', { state: 'detached' });
    const messageGroups = await page.$$eval('section.content .card-content .grid-flex .message-group', ($msgGroups) => {
      return $msgGroups.reduce((acc, $group) => {
        const author = $group.querySelector('.author').textContent;
        const messages = [];
        for (const $msg of $group.querySelectorAll('.message')) {
          const message = $msg.textContent;

          // click to show the date of message
          if (!$msg.querySelector('.state time')) {
            $msg.querySelector('a').click();
          }
          const date = new Date($msg.querySelector('.state time').getAttribute('datetime'));

          messages.push({ message, date });
        }
        acc.push({ author, messages })

        return acc;
      }, []);
    });

    return messageGroups;
  }


  console.log(`\n\nLogging in to https://account.toornament.com/ as ${process.env.ACCOUNT_USERNAME}...`)
  await page.goto('https://account.toornament.com/en_US/login/')
  await page.click('input[name="_username"]');
  await page.type('input[name="_username"]', process.env.ACCOUNT_USERNAME);
  await page.click('input[name="_password"]');
  await page.type('input[name="_password"]', process.env.ACCOUNT_PASSWORD);
  await page.click('text="Log in"');

  
  var stdin = process.stdin; 
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.on('data', function(key) {
    const ch = key.toString();

    if ( ch === '\u0003' ) {
      // ctrl-c ( end of text )
      process.exit();
    } else if (ch === ' ') {
      state.paused = !state.paused;
      console.log(state.paused ? 'Paused.\n' : 'Unpaused\n');
    }

    // write the key to stdout all normal like
    // process.stdout.write( key );
  });
  console.log('You can pause manually with SPACE key.\n');

  const firstPageNo = 1;
  let maxPageNo = firstPageNo;
  const allMessages = [];

  const fdNewMessages = argv.newMsgOutputFile ? fs.openSync(argv.newMsgOutputFile, 'w') : null;
  const fdAllMessages = argv.allMsgOutputFile ? fs.openSync(argv.allMsgOutputFile, 'w') : null;

  for (let i = firstPageNo; i <= maxPageNo; ++i) {
    while (state.paused) {
      await sleep(100);
    }

    await page.goto(`https://organizer.toornament.com/tournaments/${tournamentId}/matches/?page=${i}`);

    if (i === firstPageNo) {
      // Note: there may exist only one page
      //await page.waitForSelector('.card-footer .pagination-nav', { timeout: 5 });
      maxPageNo = await page.$$eval('.card-footer .pagination-nav .page a', $els =>
        [1, ...$els.map(el => +el.textContent)].sort((a, b) => b - a)[0]
      );
      console.log(`Page count: ${maxPageNo}`);
    }

    if (argv.headless) {
      console.log(`Checking page ${i}...\n`);
    }

    // collect matches
    const matches = await page.$$eval('section.content .card-content .size-content a', ($links: HTMLAnchorElement[]) =>
      $links.map($l => ({
        url: $l.href.substring(0, $l.href.indexOf('?')),
        players: [...$l.querySelectorAll('.opponent .name')].map(e => e.textContent)
      }))
    );

    for (let match of matches) {
      while (state.paused) {
        await sleep(100);
      }

      const messageGroups = await visitLobby(match);
      allMessages.push(messageGroups);
      
      const hasNewMessages = !!messageGroups.find(group => group.messages.find(m => m.date >= sinceDatetime));
      let str = 'Lobby: ' + match.players.join(', ');

      fdAllMessages && toFile(fdAllMessages, str, match.url);
      if (hasNewMessages) {
        console.log(colors.inverse(str));
        console.log(match.url);

        fdNewMessages && toFile(fdNewMessages, str, match.url);
      }

      for (const msgGroup of messageGroups) {
        fdAllMessages && toFile(fdAllMessages, msgGroup.author);
        if (hasNewMessages) {
          console.log('  ' + colors.green.underline(msgGroup.author));
          fdNewMessages && toFile(fdNewMessages, msgGroup.author);
        }

        for (const msg of msgGroup.messages) {
          const date = msg.date.toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(/:\d\d$/, '');

          fdAllMessages && toFile(fdAllMessages, `  ${date}`, `  ${msg.message}`, '');

          if (hasNewMessages) {
            console.log(colors.gray(`    ${date}`));
            console.log(colors.white(`    ${msg.message}`));
            console.log(' ');

            fdNewMessages && toFile(fdNewMessages, `  ${date}`, `  ${msg.message}`, '');
          }
        }
      }

      if (messageGroups.length === 0) {
        fdAllMessages && toFile(fdAllMessages, '  -- No messages here --');
      } else if (argv.pauseOnNewMessagesFor) {
        await sleep(1000 * argv.pauseOnNewMessagesFor);
      }

      fdAllMessages && toFile(fdAllMessages, '')
      if (hasNewMessages) {
        console.log('\n');
        fdNewMessages && toFile(fdNewMessages, '')
      }
      
      while (state.paused) {
        await sleep(100);
      }
    }
  }

  if (fdNewMessages) {
    fs.closeSync(fdNewMessages);
  }

  if (fdAllMessages) {
    fs.closeSync(fdAllMessages);
  }

  console.log('That\'s all folks!');
  
  // Close page
  await page.close();
})();

function testFileSave(path) {
  let normalizedPath = paths.normalize(path);

  if (!paths.isAbsolute(normalizedPath)) {
    normalizedPath = paths.join(process.cwd(), normalizedPath);
  }

  let canSave = false;

  try {
    const existed = fs.existsSync(normalizedPath);

    const fd = fs.openSync(path, 'w');
    fs.closeSync(fd);
    canSave = true;

    if (!existed) {
      fs.unlinkSync(normalizedPath);
    }
  } catch { }

  return { canSave, normalizedPath };
}

function toFile(fileDescriptor, ...lines) {
  for (const line of lines) {
    if (line) {
      fs.writeSync(fileDescriptor, line);
    }
    fs.writeSync(fileDescriptor, '\r\n');
  }
}

const sleep = (waitTimeInMs) => new Promise(resolve => setTimeout(resolve, waitTimeInMs));
