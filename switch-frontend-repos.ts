import { execSync } from 'child_process';
import { lstatSync, readdirSync } from 'fs';
import * as _ from 'lodash';
import { ConsoleLogger } from './console-logger';
import { tryExec } from './utils';
import { HERACLES_PATH, HYDRA_PATH } from './constants';

const defaultFallbackBranch = 'maintenance/weekly-70';

const [_arg1, _arg2, ...rest] = process.argv;
let [targetBranch, fallbackBranch] = rest;
if (!targetBranch) {
    throw new Error('Specify a target branch to switch the repositories to.');
}
fallbackBranch = fallbackBranch || defaultFallbackBranch;

const logger = new ConsoleLogger();
logger.log(`\nAttempting to switch frontend repos to branch ${targetBranch}`, { color: 'cyan' });

/**
 * Tries to checkout a git repo to the specified target branch, if it exists.
 * The steps executed, in order, are:
 * - resetting the repo. NOTE: all unsaved changes will be lost
 * - fetching the repo to get updates
 * - checkout the repo to the target branch, if it exists, otherwise tries to checkout a fallback branch. If missing as well, the process will stop,
 *   leaving the repository reset with no pending changes on the current branch
 * - pulls the newly checked out branch
 * @param path the path of the repo to process
 */
function checkoutRepoAt(path: string): void {
    logger.startThread(`Processing repo ${path}.`);

    const currentBranch = execSync(`git -C ${path} branch --show-current`).toString().trim();
    if (currentBranch === targetBranch) {
        logger.log('The repo is already checkout at the target branch.', { color: 'cyan' });
        logger.endThread();
        return;
    }

    tryExec(() => execSync(`git -C ${path} reset --hard`, { stdio: 'ignore' }), logger, 'Resetting changes...');
    tryExec(() => execSync(`git -C ${path} fetch`, { stdio: 'ignore' }), logger, 'Fetching repos...');
    const checkoutOk = tryExec(
        () => execSync(`git -C ${path} checkout ${targetBranch}`, { stdio: 'ignore' }),
        logger,
        `Checking out branch ${targetBranch}...`,
        `could not checkout repo ${path} to branch ${targetBranch}`
    );
    if (!checkoutOk) {
        const fallbackCheckoutOk = tryExec(
            () => execSync(`git -C ${path} checkout ${fallbackBranch}`, { stdio: 'ignore' }),
            logger,
            `Trying to checkout fallback branch ${fallbackBranch}.`,
            `could not checkout repo ${path} to fallback branch ${fallbackBranch}.`
        );
        if (!fallbackCheckoutOk) {
            logger.log('Skipping repo.', { color: 'yellow' });
            logger.endThread();
            return;
        }
    }
    tryExec(() => execSync(`git -C ${path} pull`, { stdio: 'ignore' }), logger, 'Pulling branch...');
    logger.endThread();
}

checkoutRepoAt(HERACLES_PATH);

const hydraProjects = _.chain(readdirSync(HYDRA_PATH))
    .filter(path => !path.startsWith('.'))
    .map(path => `${HYDRA_PATH}/${path}`)
    .filter(path => {
        try {
            return lstatSync(path).isDirectory() && lstatSync(`${path}/.git`).isDirectory();
        } catch (err) {
            return false;
        }
    })
    .value()
    ;
_.each(hydraProjects, checkoutRepoAt);
