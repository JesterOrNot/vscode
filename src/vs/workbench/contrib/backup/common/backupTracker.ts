/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { Disposable, IDisposable, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { ITextFileService, ITextFileEditorModel } from 'vs/workbench/services/textfile/common/textfiles';
import { IUntitledTextEditorService } from 'vs/workbench/services/untitled/common/untitledTextEditorService';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IFilesConfigurationService, IAutoSaveConfiguration } from 'vs/workbench/services/filesConfiguration/common/filesConfigurationService';
import { IWorkingCopyService, IWorkingCopy, WorkingCopyCapabilities } from 'vs/workbench/services/workingCopy/common/workingCopyService';
import { Schemas } from 'vs/base/common/network';
import { UntitledTextEditorModel } from 'vs/workbench/common/editor/untitledTextEditorModel';
import { ILogService } from 'vs/platform/log/common/log';

export class BackupTracker extends Disposable implements IWorkbenchContribution {

	// Disable backup for when a short auto-save delay is configured with
	// the rationale that the auto save will trigger a save periodically
	// anway and thus creating frequent backups is not useful
	//
	// This will only apply to working copies that are not untitled where
	// auto save is actually saving.
	private static DISABLE_BACKUP_AUTO_SAVE_THRESHOLD = 1500;

	// Delay creation of backups when content changes to avoid too much
	// load on the backup service when the user is typing into the editor
	private static BACKUP_FROM_CONTENT_CHANGE_DELAY = 1000;

	private backupsDisabledForAutoSaveables = false;

	private readonly pendingBackups = new Map<URI, IDisposable>();

	constructor(
		@IBackupFileService private readonly backupFileService: IBackupFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IUntitledTextEditorService private readonly untitledTextEditorService: IUntitledTextEditorService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.registerListeners();
	}

	private registerListeners() {

		// Listen for generic working copy changes to backup
		this._register(this.workingCopyService.onDidChangeContent(c => this.onDidChangeWorkingCopyContent(c)));

		// Listen for text file model changes
		this._register(this.textFileService.models.onModelSaved(e => this.discardBackup(e.resource)));
		this._register(this.textFileService.models.onModelReverted(e => this.discardBackup(e.resource)));
		this._register(this.textFileService.models.onModelDisposed(e => this.discardBackup(e.resource)));

		// Listen for untitled model changes
		this._register(this.untitledTextEditorService.onDidCreate(e => this.onDidCreateUntitled(e)));
		this._register(this.untitledTextEditorService.onDidDisposeModel(e => this.discardBackup(e)));

		// Listen to auto save config changes
		this._register(this.filesConfigurationService.onAutoSaveConfigurationChange(c => this.onAutoSaveConfigurationChange(c)));
	}

	private onAutoSaveConfigurationChange(configuration: IAutoSaveConfiguration): void {
		this.backupsDisabledForAutoSaveables = typeof configuration.autoSaveDelay === 'number' && configuration.autoSaveDelay < BackupTracker.DISABLE_BACKUP_AUTO_SAVE_THRESHOLD;
	}

	private onDidChangeWorkingCopyContent(workingCopy: IWorkingCopy): void {
		if (!workingCopy.isDirty()) {
			this.discardBackup(workingCopy.resource);
			return; // discard any backup and return if working copy not dirty
		}

		if (this.backupsDisabledForAutoSaveables && !(workingCopy.capabilities & WorkingCopyCapabilities.Untitled)) {
			return; // return if backups are disabled for auto-saveables
		}

		// Untitled
		if (workingCopy.resource.scheme === Schemas.untitled) {
			this.untitledTextEditorService.createOrGet({ resource: workingCopy.resource }).resolve().then(model => this.backupModel(model));
		}

		//Files
		else {
			const model = this.textFileService.models.get(workingCopy.resource);
			if (model) {
				this.backupModel(model);
			}

			// TODO@Ben TODO@matt add a generic backup solution for all working copies
		}
	}

	private onDidCreateUntitled(resource: URI): void {
		if (this.untitledTextEditorService.isDirty(resource)) {
			this.untitledTextEditorService.createOrGet({ resource }).resolve().then(model => this.backupModel(model));
		}
	}

	private backupModel(model: ITextFileEditorModel | UntitledTextEditorModel): void {

		// Clear any running backup operation
		dispose(this.pendingBackups.get(model.resource));
		this.pendingBackups.delete(model.resource);

		// Working copy is dirty - start backup after delay
		if (model.isDirty()) {
			this.logService.trace(`[backup tracker] starting to backup`, model.resource.toString());

			// Schedule new backup
			const handle = setTimeout(() => {

				// Clear disposable
				this.pendingBackups.delete(model.resource);

				// Backup if still dirty
				if (model.isDirty()) {
					this.logService.trace(`[backup tracker] running backup`, model.resource.toString());

					model.backup();
				}
			}, BackupTracker.BACKUP_FROM_CONTENT_CHANGE_DELAY);

			// Keep in map for disposal as needed
			this.pendingBackups.set(model.resource, toDisposable(() => clearTimeout(handle)));
		}
	}

	private discardBackup(resource: URI): void {
		this.logService.trace(`[backup tracker] discarding backup`, resource.toString());

		// Clear any running backup operation
		dispose(this.pendingBackups.get(resource));
		this.pendingBackups.delete(resource);

		// Forward to backup file service
		this.backupFileService.discardResourceBackup(resource);
	}
}
