import { Chalk, Instance } from 'chalk';
import * as _ from 'lodash';

export interface LogOptions {
    color?: LogColor;
    skipIndentation?: boolean;
}

export type LogColor = keyof Pick<Chalk, 'green' | 'red' | 'cyan' | 'yellow'>;

export class ConsoleLogger {
    private readonly chalk = new Instance();
    private readonly TAB_SIZE = 4;
    private indentation = 0;

    startThread(message: string): void {
        this.log('\n');
        this.log(message, { color: 'green' });
        this.indent();
    }
    endThread(): void {
        this.outdent();
    }
    log(message: string, options?: LogOptions): void {
        const color = options?.color;
        const skipIndentation = options?.skipIndentation || false;
        const coloredMessage = color ? this.chalk[color](message) : message;
        console.log(`${skipIndentation ? '' : _.repeat(' ', this.TAB_SIZE * this.indentation)}${coloredMessage}`);
    }
    error(message: string): void {
        this.log(message, { color: "red" });
    }

    private indent(): void {
        ++this.indentation;
    }
    private outdent(): void {
        --this.indentation;
    }
}
