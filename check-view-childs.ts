import { promises as fsp, readdirSync, lstatSync, createWriteStream, mkdirSync } from "fs";
import { parse, NodeType, HTMLElement } from "node-html-parser";
import { join as joinPaths } from "path";
import _ from "lodash";
import { HERACLES_PATH, HYDRA_PATH } from "./constants";

export enum ViewChildDeclarationStatus {
	Unspecified,
	Static,
	NonStatic,
}

function dsToString(staticness: ViewChildDeclarationStatus): string {
	switch (staticness) {
		case ViewChildDeclarationStatus.Unspecified:
			return "Unspecified";
		case ViewChildDeclarationStatus.Static:
			return "Static";
		case ViewChildDeclarationStatus.NonStatic:
			return "NonStatic";
	}
}

export enum NgLifecycleHook {
	Construction,
	OnInit,
	AfterViewInit,
	Unspecified,
}

function lhToString(hook: NgLifecycleHook): string {
	switch (hook) {
		case NgLifecycleHook.Unspecified:
			return "Unspecified";
		case NgLifecycleHook.AfterViewInit:
			return "AfterViewInit";
		case NgLifecycleHook.OnInit:
			return "OnInit";
		case NgLifecycleHook.Construction:
			return "Construction";
	}
}

export enum InspectionStatus {
	Ok,
	Warning,
	Error,
	Unknown,
}

function isToString(status: InspectionStatus): string {
	switch (status) {
		case InspectionStatus.Unknown:
			return "Unknown";
		case InspectionStatus.Error:
			return "Error";
		case InspectionStatus.Warning:
			return "Warning";
		case InspectionStatus.Ok:
			return "Ok";
	}
}

export interface IViewChildInspectionReport {
	firstUsedIn: string;
	currentStatus: string;
	correctStatus: string;
	message: string;
}

export class ViewChildInspectionResult {
	statusText: string;

	constructor(
		public name: string,
		public processed: boolean,
		public status: InspectionStatus,
		public notProcessedReason?: string,
		public lineNumber?: number,
		public problems?: IViewChildInspectionReport
	) {
		this.statusText = isToString(this.status);
	}
}

export class FileInspectionResult {
	statusText: string;

	constructor(
		public processed: boolean,
		public status: InspectionStatus,
		public notProcessedReason?: string,
		public viewChilds?: ViewChildInspectionResult[]
	) {
		this.statusText = isToString(this.status);
	}
}

class ViewChildMissing extends Error {
	constructor(message: string) {
		super(message);
	}
}

async function checkViewChilds(filePath: string): Promise<FileInspectionResult> {
	const AngularComponentRegex = /@Component\(/gm;
	const AngularDirectiveRegex = /@Directive\(/gm;
	const ViewChildSpotterRegex = /@ViewChild\(/gm;
	const ViewChildRegex = /@ViewChild\s*\(\s*(?<childSelector>('|")?\w+('|")?)(\s*,\s*{\s*static\s*:\s*(?<isDeclaredStatic>true|false)\s*}\s*)?\)\s*(?<propName>\w+)(.*)?;/gm;
	const TsClassRegex = /((\s*export\s*(abstract\s*)?)|^\s*)class\s*[^}]+\s*{/gm;

	const tsFile = (await fsp.readFile(filePath, {
		encoding: "UTF-8",
	})) as string;
	const nClassesPerFile = tsFile.match(TsClassRegex)?.length ?? 0;
	if (nClassesPerFile === 0) {
		return new FileInspectionResult(false, InspectionStatus.Ok, "This file does not contain any Typescript class, therefore no components");
	}
	if (nClassesPerFile > 1) {
		return new FileInspectionResult(false, InspectionStatus.Unknown, "This file contains more than one Typescript class, check the content manually");
	}

	const isAngularComponent = AngularComponentRegex.test(tsFile);
	const isAngularDirective = AngularDirectiveRegex.test(tsFile);
	if (!isAngularComponent && !isAngularDirective) {
		return new FileInspectionResult(false, InspectionStatus.Ok, "This file does not contain neither a Component nor a Directive");
	}

	const viewChildsCount = tsFile.match(ViewChildSpotterRegex)?.length ?? 0;
	if (viewChildsCount === 0) {
		return new FileInspectionResult(false, InspectionStatus.Ok, "This Component does not contain any ViewChild properties");
	}

	const componentTemplate = await getComponentTemplate(tsFile, filePath);
	if (!componentTemplate) {
		return new FileInspectionResult(false, InspectionStatus.Unknown, "Could not retrieve the template for this Component");
	}

	let matches = ViewChildRegex.exec(tsFile);
	const viewChilds: ViewChildInspectionResult[] = [];
	while (matches) {
		const { childSelector, isDeclaredStatic, propName } = matches.groups;
		try {
			const viewChild = checkViewChild(componentTemplate, tsFile, childSelector, isDeclaredStatic === "true", propName);
			viewChilds.push(viewChild);
		} catch (err) {
			viewChilds.push(
				err instanceof ViewChildMissing
					? new ViewChildInspectionResult(
							propName,
							false,
							InspectionStatus.Warning,
							`This ViewChild is declared in the component but it's not in the template, and can therefore be removed`
					  )
					: new ViewChildInspectionResult(propName, false, InspectionStatus.Unknown, `Error processing - ${err.message}`)
			);
		}
		matches = ViewChildRegex.exec(tsFile);
	}

	return new FileInspectionResult(
		true,
		_.chain(viewChilds)
			.map(vc => vc.status)
			.max()
			.value(),
		undefined,
		viewChilds
	);
}

function checkViewChild(htmlTemplate: string, tsFile: string, childSelector: string, isDeclaredStatic: boolean, propName: string): ViewChildInspectionResult {
	const selectorIsComponentClass = !childSelector.startsWith("'") && !childSelector.startsWith('"');
	if (selectorIsComponentClass) {
		// TODO
		return new ViewChildInspectionResult(propName, false, InspectionStatus.Unknown, "ViewChild selected by component class are not supported yet");
	}

	// Extract the name of the template variable to search in the template
    const templateVar = childSelector.substring(1, childSelector.length - 1);

	const isStatic = isElementStatic(htmlTemplate, templateVar);
	const lineNumber = getViewChildLineNumber(tsFile, propName);
	const firstUsedIn = isPropertyUsedInMethod(tsFile, propName, "constructor")
        ? NgLifecycleHook.Construction
        : isPropertyUsedInMethod(tsFile, propName, "ngOnInit")
		? NgLifecycleHook.OnInit
		: isPropertyUsedInMethod(tsFile, propName, "ngAfterViewInit")
		? NgLifecycleHook.AfterViewInit
		: NgLifecycleHook.Unspecified;

	if (isDeclaredStatic) {
		// If the element is declared static and it actually is, no problems, the view child can be used inside ngOnInit
		if (isStatic) {
			return new ViewChildInspectionResult(propName, true, InspectionStatus.Ok);
		}

		return new ViewChildInspectionResult(
			propName,
			true,
			firstUsedIn > NgLifecycleHook.OnInit ? InspectionStatus.Warning : InspectionStatus.Error,
			undefined,
			lineNumber,
			{
				currentStatus: dsToString(ViewChildDeclarationStatus.Static),
				correctStatus: dsToString(ViewChildDeclarationStatus.NonStatic),
				firstUsedIn: lhToString(firstUsedIn),
				message: `ViewChild ${propName} is marked as static but in the component's template it, or one of its parents, is inside a structural directive`,
			}
		);
	}

	if (isStatic) {
		return new ViewChildInspectionResult(propName, true, InspectionStatus.Warning, undefined, lineNumber, {
			currentStatus: dsToString(ViewChildDeclarationStatus.NonStatic),
			correctStatus: dsToString(ViewChildDeclarationStatus.Static),
			firstUsedIn: lhToString(firstUsedIn),
			message: `ViewChild ${propName} is marked as non static but in the component's template it is not placed inside any structural directive, so it can be marked as static`,
		});
	}

	return firstUsedIn > NgLifecycleHook.OnInit
		? new ViewChildInspectionResult(propName, true, InspectionStatus.Ok)
		: new ViewChildInspectionResult(propName, true, InspectionStatus.Error, undefined, lineNumber, {
				currentStatus: dsToString(ViewChildDeclarationStatus.NonStatic),
				correctStatus: dsToString(ViewChildDeclarationStatus.Static),
				firstUsedIn: lhToString(firstUsedIn),
				message: `ViewChild ${propName} is non static but in the component it is used before being captured by Angular, inside ${
					firstUsedIn === NgLifecycleHook.OnInit ? "ngOnInit" : "the constructor"
				}`,
		  });
}

/**
 * Searches a Typescript file of an Angular component to find at which line a property of the component is declared
 * @param tsFile the Typescript file to analyze
 * @param propName the name of the component's property
 */
function getViewChildLineNumber(tsFile: string, propName: string): number {
	const PropDeclarationRegex = new RegExp(`${propName} *:`);
	const lines = _.split(tsFile, "\n");
	const line = _.find(lines, l => !l.trim().startsWith("*") && !l.trim().startsWith("//") && PropDeclarationRegex.test(l));
	return _.indexOf(lines, line) + 1;
}

/**
 * Checks whether a property is used inside a certain method in the Typescript class contained in the provided file
 * @param tsFile the Typescript file to inspect
 * @param propName the property to check if used in the specified method
 * @param methodName the method of the Typescript class to search
 */
function isPropertyUsedInMethod(tsFile: string, propName: string, methodName: string): boolean {
	const GetMethodStartRegex = () => new RegExp('\\s*(private|public|protected\\s*)?' + methodName + '\\s*\\([^\\)]*\\)\\s*(:\\s*\\w+\\s*)?{');
    const lines = _.split(tsFile, "\n");
    // Find the line where the method to search is declared
	const methodStart = _.find(lines, l => GetMethodStartRegex().test(l));
	if (!methodStart) {
		// The method doesn't exist, therefore propName isn't used in that method
		return false;
	}

    const indexOfStart = _.indexOf(lines, methodStart);
	// Since method bodies can contain closing braces, and I can't implement a JS parser, try to find the end of the method
	// with a simple heuristic: by assuming that noone closes a method's brace on the same line of the return statement,
	// find a line consisting of a single closing brace (optionally followed by a semi colon) and preceded by the same
	// spacing as the opening line
	const leadingSpaces = _.filter(methodStart, char => /\s/.test(char));
	// Account for usage of mixed spaces and tabs; tab width doesn't really matter in this calculation
	const TAB_WIDTH = 4;
	const equivalentSpacing = _.reduce(leadingSpaces, (total, space) => total + (space === "\t" ? TAB_WIDTH : 1), 0);
	const MethodEndRegex = () => new RegExp(`${_.repeat(" ", equivalentSpacing)}}(\\s*; *)?`);
	const methodEnd = _.chain(lines)
		.takeRight(lines.length - (indexOfStart + 1))
		.find(l => MethodEndRegex().test(l))
		.value();
	if (!methodEnd) {
        //throw new Error("Heuristic recognition of method end has failed");
        return false;
	}

	const indexOfEnd = _.indexOf(lines, methodEnd);
	const methodBody = _.chain(lines)
		.takeRight(lines.length - (indexOfStart + 1))
		.take(indexOfEnd - indexOfStart)
		.value();

	// Now search the method's body
	const PropertyUsageRegex = () => new RegExp(`\\s*this\\.${propName}\\b`, "gm");
	return _.some(methodBody, line => PropertyUsageRegex().test(line));
}

/**
 * Inspects a Typescript file containing a single Component class and tries to retrieve its HTML template.
 * @param tsFileContent the Typescript file of the angular component to inspect
 * @param tsFileFullPath the full path where the TS file is
 * @returns the content of the component's template, if found; null otherwise
 */
async function getComponentTemplate(tsFileContent: string, tsFileFullPath: string): Promise<string> {
	const NgComponentDecoratorParamsRegex = () => /@Component\s*\(\s*{(?<decoratorParams>\s*[^}]*\s*,?\s*)}\s*\)/gm;
	const NgComponentTemplateRegex = () => /template\s*:\s*'(?<template>[^']+)'/gm;
	const NgComponentMultilineTemplateRegex = () => /template\s*:\s*`(?<template>[^`]+)`/gm;
	const NgComponentTemplateUrlRegex = () => /templateUrl\s*:\s*('|")(?<templateUrl>[\w\-\.\/]+)('|")/gm;

	if (!NgComponentDecoratorParamsRegex().test(tsFileContent)) {
		return null;
	}
	const {
		groups: { decoratorParams },
	} = NgComponentDecoratorParamsRegex().exec(tsFileContent);

	if (NgComponentTemplateUrlRegex().test(decoratorParams)) {
		const {
			groups: { templateUrl },
		} = NgComponentTemplateUrlRegex().exec(decoratorParams);
		const isAbsolute = templateUrl.startsWith("/");
		if (isAbsolute) {
			// Angular templates referenced via with absolute urls are not the norm, not handled.
			return null;
		}

		const tsFileFolder = tsFileFullPath.substring(0, tsFileFullPath.lastIndexOf("/"));
		const inSameFolder = !templateUrl.startsWith("..");
		const templatePath = joinPaths(tsFileFolder, templateUrl);
		const template = (await fsp.readFile(templatePath, { encoding: "UTF-8" })) as string;
		return template;
	}

	if (NgComponentTemplateRegex().test(decoratorParams)) {
		const {
			groups: { template },
		} = NgComponentTemplateRegex().exec(decoratorParams);
		return template;
	}

	if (NgComponentMultilineTemplateRegex().test(decoratorParams)) {
		const {
			groups: { multilineTemplate },
		} = NgComponentMultilineTemplateRegex().exec(decoratorParams);
		return multilineTemplate;
	}

	return null;
}

/**
 * Searches an Angular template for an element with a given variable name (e.g.: <div #element></div>)
 * and checks whether such element, or any of its parents, are conditionally rendered due to the presence
 * of a structural directive
 * @param html the component's HTML to inspect
 * @param elementName the template variable name of the element to search
 * @returns whether the element is static (i.e.: no structural directives on it or its parents)
 */
function isElementStatic(html: string, elementName: string): boolean {
	const root = parse(html);
	if (!root.valid) {
		throw new Error("The provided template is invalid");
	}

	const ref = { conditional: false };
	const htmlNodes = _.filter(root.childNodes, n => n.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[];
	const childWithElement = _.find(htmlNodes, n => containsElement(n, elementName, ref));
	if (!childWithElement) {
		throw new ViewChildMissing(`Element associated to template variable ${elementName} must be in the template`);
	}
	return !ref.conditional;
}

/**
 * This function checks whether a given DOM element contains a tag with the specified template variable.
 * First it checks if the DOM element itself is that variable, then if any of its children has or contains it,
 * in a recursive fashion
 * @param node the DOM element to inspect
 * @param elementName the template variable to search for
 * @param ref the control object which is used to track whether the element is inside a structural directive.
 * @example
 * <div class="toSearch">
 *   <div class="firstChild">
 *     <span #theElement class="child1"></span>
 *   <div class="secondChild">
 *     <span></span>
 *   </div>
 * </div>
 * ...
 * containsElement($(".toSearch")[0], "theElement", { conditional: false }) --> true (ref.conditional == false)
 * @example
 * <div class="toSearch">
 *   <div *ngIf="condition" class="firstChild">
 *     <span #theElement class="child1"></span>
 *   <div class="secondChild">
 *     <span></span>
 *   </div>
 * </div>
 * ...
 * containsElement($(".toSearch")[0], "theElement", { conditional: false }) --> true (ref.conditional == true)
 */
function containsElement(node: HTMLElement, elementName: string, ref: { conditional: boolean }): boolean {
	if (isTheElement(node, elementName)) {
		if (isConditional(node)) {
			ref.conditional = true;
		}
		return true;
	}

	for (const child of _.filter(node.childNodes, n => n.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[]) {
		if (containsElement(child, elementName, ref)) {
			if (isConditional(child)) {
				ref.conditional = true;
			}
			return true;
		}
	}
	return false;
}

/**
 * Checks whether a given DOM element is referenced with the given variable name in an Angular template
 * @param node the DOM element to check
 * @param elementName the template variable name
 */
function isTheElement(node: HTMLElement, elementName: string): boolean {
	return new RegExp(`\\s*#${elementName}\\s*`, "gm").test((node as any).rawAttrs as string);
}

/**
 * Checks whether a given DOM element is subject to a structural directive which can not guarantee its present in the DOM
 * @param element the DOM element to inspect
 */
function isConditional(element: HTMLElement): boolean {
	const hasNgIf = element.hasAttribute("ngIf");
	const hasNgFor = element.hasAttribute("ngFor");
	const hasNgSwitch = element.hasAttribute("ngSwitchCase") || element.hasAttribute("ngSwitchDefault");
	return hasNgIf || hasNgFor || hasNgSwitch;
}

/**
 * This function searches a folder recursively an returns all the files that match a given extension
 * @param directoryPath the directory where to search
 * @param extension the extension that the searched files must have to be matched
 * @param arrayOfFiles the array of files where to append the files found (the function is recursive)
 */
function getAllFiles(directoryPath: string, extension: string, arrayOfFiles: string[]): string[] {
	arrayOfFiles = arrayOfFiles || [];

	const entries = readdirSync(directoryPath);
	entries.forEach(entry => {
		const fullPath = joinPaths(directoryPath, entry);
		if (lstatSync(fullPath).isDirectory()) {
			arrayOfFiles = getAllFiles(fullPath, extension, arrayOfFiles);
		} else if (entry.endsWith(`.${extension}`)) {
			arrayOfFiles.push(joinPaths(directoryPath, entry));
		}
	});

	return arrayOfFiles;
}

function buildReport(projectName: string, projectPath: string, map: Map<string, FileInspectionResult>): void {
	const writer = createWriteStream(`./reports/vc_report_${projectName}.json`, { flags: "w", encoding: "UTF-8" });
	writer.write(`//// Repository: ${projectName} <<<`);
	writer.write("\n\n");

	type FileWithResult = { file: string; result: FileInspectionResult };
	const unprocessed: FileWithResult[] = [];
	const errors: FileWithResult[] = [];
	const warnings: FileWithResult[] = [];
	const ok: FileWithResult[] = [];
	map.forEach((result, filePath) => {
		const file = filePath.replace(`${projectPath}/`, "");
		switch (result.status) {
			case InspectionStatus.Unknown:
				unprocessed.push({ file, result });
				break;
			case InspectionStatus.Error:
				errors.push({ file, result });
				break;
			case InspectionStatus.Warning:
				warnings.push({ file, result });
				break;
			case InspectionStatus.Ok:
				ok.push({ file, result });
				break;
		}
	});

	function printFiles(files: FileWithResult[]): void {
		const status = _.first(files)?.result.status;
		if (!status) {
			// No files with this status
			return;
		}
		const obj = {
			status: isToString(status),
			files,
		};
		writer.write(JSON.stringify(obj, undefined, "\t"));
		writer.write("\n\n");
	}

	writer.write(`// Files with ViewChilds that have not been checked <`);
	writer.write("\n");
	printFiles(unprocessed);

	writer.write(`// Files with ViewChilds that have errors <`);
	writer.write("\n");
	printFiles(errors);

	writer.write(`// Files with ViewChilds that have warnings <`);
	writer.write("\n");
	printFiles(warnings);

	writer.write(`// Files with ViewChilds that have no problems <`);
	writer.write("\n");
	printFiles(ok);
}

async function inspectProject(projectPath: string, projectName?: string): Promise<void> {
	projectName = projectName ?? projectPath.substring(projectPath.lastIndexOf("/") + 1);
	const map = new Map<string, FileInspectionResult>();
	const tsFilesInProject = getAllFiles(projectPath, "ts", []);
	const promises = _.map(tsFilesInProject, tsFile => checkViewChilds(tsFile).then(result => map.set(tsFile, result)));
	await Promise.all(promises);

	buildReport(projectName, projectPath, map);
}

async function main() {
    // await checkViewChilds(joinPaths(HYDRA_PATH, "course", "edit/components/course-edit/tabs/tab-catalogs/courses-catalogs-tab.component.ts"));
    // return;

    // Ensure the reports folder exists
    try {
        lstatSync("./reports").isDirectory() && console.log("./reports directory found. Proceeding.");
    } catch (err) {
        console.log("./reports directory NOT found. It will be created before proceeding.");
        mkdirSync("./reports");
    }

	await inspectProject(joinPaths(HERACLES_PATH, "src"), "Heracles");

	const hydraProjects = _.chain(readdirSync(HYDRA_PATH))
		.filter(path => !path.startsWith("."))
		.map(path => `${HYDRA_PATH}/${path}`)
		.filter(path => {
			try {
				return lstatSync(path).isDirectory() && lstatSync(`${path}/.git`).isDirectory();
			} catch (err) {
				return false;
			}
		})
		.value();
	_.each(hydraProjects, async projectPath => inspectProject(projectPath));
}

main();
