import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { TRACKER_PRIORITY_KEYS } from '@/components/references/referencePickerItems';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { TrackerItem, TrackerPriority } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { createTrackerItem, deleteTrackerItem, editTrackerItem } from '@/lib/trackers/mutations';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import type { TrackerCreateItemInput, TrackerDeleteItemInput, TrackerEditItemInput } from '@/lib/trackers/types';
import { SourceBoardTextChoiceField } from './SourceBoardTextChoiceField';

// The form never offers `none`: a local issue always has a priority (default low).
const PRIORITIES: readonly Exclude<TrackerPriority, 'none'>[] = ['urgent', 'high', 'medium', 'low'];

const labelsOf = (value: string): string[] => (
  value.split(',').map((label) => label.trim()).filter(Boolean)
);

/**
 * An edit that names the project the item lives in. A number repeats in every
 * project's issues, so without it the tracker finds the first project holding
 * that number and edits that one. A JSON body drops an undefined field, which
 * is what an item that names no project gets.
 */
const editOf = (input: TrackerEditItemInput & { containerId: string }): TrackerEditItemInput => (
  input.containerId ? input : { ...input, containerId: undefined }
);

/**
 * Create or edit one tracker item, from the board's New issue button and Edit
 * issue action. The form holds the fields `items/create` and `items/edit`
 * take, except a blocker list: it is edited on the item itself, where the
 * issues that could block it are there to pick instead of typed by key. A
 * failed submit keeps every field so the user can retry, and `onDone` lets the
 * caller refresh what it lists. The dialog's project options are the caller's
 * containers, the first of them preselected.
 *
 * Edit mode also deletes the item, where the tracker's `delete` capability
 * allows it: the button asks once more before it runs, since the file behind a
 * local issue is gone for good afterwards.
 */
export const TrackerIssueDialog: React.FC<{
  provider: string;
  mode: 'create' | 'edit';
  /** The containers (a Linear team, a local project) create mode offers. */
  containers: { id: string; name: string }[];
  /** The grouping slugs already in use, so an existing one is picked rather than retyped. */
  featureOptions?: readonly string[];
  /** The item edit mode works on. */
  initial?: TrackerItem;
  /** Called once the tracker deleted the item; the caller drops it from its list. */
  onDeleted?: (identifier: string) => void;
  onDone: (item: TrackerItem) => void;
  onClose: () => void;
}> = ({ provider, mode, containers, featureOptions = [], initial, onDeleted, onDone, onClose }) => {
  const { t } = useI18n();
  const { capabilities } = useTrackerDescriptor(provider);
  const isCreate = mode === 'create';
  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [priority, setPriority] = React.useState<TrackerPriority>(
    initial?.priority && initial.priority !== 'none' ? initial.priority : 'low',
  );
  const [containerId, setContainerId] = React.useState(containers[0]?.id ?? '');
  const [labels, setLabels] = React.useState((initial?.labels ?? []).map((label) => label.name).join(', '));
  const [feature, setFeature] = React.useState(initial?.feature ?? '');
  const [submitting, setSubmitting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // A delete takes two clicks: the first turns the button into the one that
  // does it, so a slip on a toolbar-sized target cannot unlink an issue.
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleteFailed, setDeleteFailed] = React.useState(false);

  const canSubmit = Boolean(title.trim()) && !submitting && !confirmingDelete
    && (isCreate ? containerId !== '' : Boolean(initial?.id));
  const editContainerId = initial?.container?.id ?? '';
  // Sent only where the tracker has the field: one without it is never handed a
  // value it would have to drop.
  const grouping: Pick<TrackerCreateItemInput, 'feature'> = {};
  if (capabilities.feature) grouping.feature = feature.trim() || null;
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setFailed(false);
    try {
      const item = isCreate
        ? await createTrackerItem(provider, {
          containerId,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          labels: labelsOf(labels),
          ...grouping,
        })
        : await editTrackerItem(provider, editOf({
          id: initial?.id ?? '',
          containerId: editContainerId,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          labels: labelsOf(labels),
          ...grouping,
        }));
      onDone(item);
      onClose();
    } catch {
      // The fields stay as they are; only the footer says the submit failed.
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  // A value outside the known set (a server ahead of this UI) reads as low.
  const priorityLabel = (value: string | undefined): string => (
    t(TRACKER_PRIORITY_KEYS[PRIORITIES.find((item) => item === value) ?? 'low'])
  );
  // Deleting is offered where an item exists to delete and the tracker can do
  // it: a create form has nothing to remove, and a tracker without the bit has
  // no route behind the button.
  const canDelete = !isCreate && capabilities.delete === true && Boolean(initial?.id);
  const remove = async () => {
    if (!canDelete || submitting) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setDeleteFailed(false);
      return;
    }
    setSubmitting(true);
    setDeleteFailed(false);
    try {
      // Named with its container for the same reason an edit is: the number
      // repeats in every project, and the one without the hint is the first.
      const target: TrackerDeleteItemInput = { id: initial?.id ?? '' };
      if (editContainerId) target.containerId = editContainerId;
      await deleteTrackerItem(provider, target);
      onDeleted?.(initial?.identifier ?? '');
      onClose();
    } catch {
      setDeleteFailed(true);
      // Back to one click: the confirm state belongs to a delete that ran.
      setConfirmingDelete(false);
    } finally {
      setSubmitting(false);
    }
  };
  const submitLabel = isCreate ? t('sourceBoard.tracker.create.submit') : t('sourceBoard.tracker.edit');
  const failureText = isCreate ? t('sourceBoard.tracker.create.failed') : t('sourceBoard.tracker.edit.failed');
  const footerFailure = deleteFailed ? t('sourceBoard.tracker.delete.failed') : failureText;
  const deleteControl = canDelete ? (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant={confirmingDelete ? 'destructive' : 'ghost'}
        size="sm"
        className={confirmingDelete ? undefined : 'text-destructive hover:text-destructive'}
        disabled={submitting}
        onClick={() => void remove()}
      >
        {t(confirmingDelete ? 'sourceBoard.tracker.delete.confirm' : 'sourceBoard.tracker.delete')}
      </Button>
      {confirmingDelete ? (
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => setConfirmingDelete(false)}>
          {t('dialog.common.actions.cancel')}
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isCreate ? t('sourceBoard.tracker.create.title') : t('sourceBoard.tracker.edit')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <SettingsStackedField label={t('gitView.pr.field.title')} controlClassName="max-w-none">
            <Input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
          </SettingsStackedField>
          <SettingsStackedField label={t('gitView.pr.field.description')} controlClassName="max-w-none">
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-[120px]" />
          </SettingsStackedField>
          {isCreate ? (
            <SettingsStackedField label={t('sourceBoard.tracker.create.project')} controlClassName="max-w-none">
              <Select value={containerId} onValueChange={setContainerId}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(value: string | undefined) => containers.find((container) => container.id === value)?.name ?? ''}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {containers.map((container) => (
                    <SelectItem key={container.id} value={container.id}>{container.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsStackedField>
          ) : null}
          <SettingsStackedField label={t('references.picker.preview.priority')} controlClassName="max-w-none">
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger className="w-full">
                <SelectValue>{priorityLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((value) => (
                  <SelectItem key={value} value={value}>{priorityLabel(value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>
          <SettingsStackedField label={t('references.picker.preview.labels')} controlClassName="max-w-none">
            <Input value={labels} onChange={(event) => setLabels(event.target.value)} />
          </SettingsStackedField>
          {capabilities.feature ? (
            <SettingsStackedField label={t('sourceBoard.tracker.form.feature')} controlClassName="max-w-none">
              <SourceBoardTextChoiceField
                value={feature}
                options={featureOptions}
                onChange={setFeature}
                ariaLabel={t('sourceBoard.tracker.form.feature')}
                placeholder={t('sourceBoard.tracker.form.feature.placeholder')}
                searchPlaceholder={t('sourceBoard.tracker.form.feature.search')}
                emptyText={t('sourceBoard.tracker.form.feature.empty')}
                createLabel={(typed) => t('sourceBoard.tracker.form.feature.create', { value: typed })}
                clearLabel={t('sourceBoard.tracker.form.feature.clear')}
              />
            </SettingsStackedField>
          ) : null}
        </div>
        <DialogFooter>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
            <p className="flex min-h-4 min-w-0 flex-1 items-center gap-1.5 typography-micro text-destructive" aria-live="polite">
              {failed || deleteFailed ? <><Icon name="error-warning" className="size-3.5 shrink-0" />{footerFailure}</> : null}
            </p>
            {deleteControl}
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose}>
                {t('dialog.common.actions.cancel')}
              </Button>
              <Button type="button" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
                {submitting ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                {submitLabel}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
