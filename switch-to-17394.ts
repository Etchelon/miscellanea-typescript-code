import { execSync } from 'child_process';
import * as _ from 'lodash';
import { ConsoleLogger } from './console-logger';
import { HERACLES_PATH } from './constants';
import { tryExec } from './utils';

const [_arg1, _arg2, ...rest] = process.argv;
const runStart = _.first(rest) === 'start';

const logger = new ConsoleLogger();

tryExec(
    () => execSync('ts-node switch-frontend-repos.ts core4/DOC-17394_new_power_users_management architecture/devops-247_Angular9_PHP74_upgrade', { stdio: 'inherit' }),
    logger,
    'Switching all frontend repos to the Angular9 based feature branch...'
);

tryExec(
    () => execSync(`cd ${HERACLES_PATH} && npm i`),
    logger,
    'Installing NPM packages. It will take a while...'
);

if (runStart) {
    tryExec(
        () => execSync(`cd ${HERACLES_PATH} && npm run start -- dev`),
        logger,
        'Launching the Angular build in watch mode. This will take an even longer while...'
    );
}
