import { ConsoleLogger } from './console-logger';

/**
 * Wraps the execution of a function and reports if it executed correctly or not
 * @param action the function to execute
 * @param logger an instance of a console logger
 * @param message the message to log before executing the action
 * @param failureMessage the optional message to show upon error. If omitted, the actual error's message will be used
 */
export function tryExec(action: () => void, logger: ConsoleLogger, message: string, failureMessage?: string): boolean {
    logger.log(message);
    try {
        action();
        logger.log(`...done.\n`);
        return true;
    } catch (err) {
        logger.error(`...${failureMessage || err.message}.\n`);
        return false;
    }
};
