import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { recordLabelWrite } from '@/components/references/labelWrites';
import type { CachedValue } from '@/components/references/referenceCache';
import { labelColor, referenceNumberLabel } from '@/components/references/referencePickerItems';
import { ReferenceLabelChips } from '@/components/references/ReferencePickerRow';
import { ReviewerPerson } from '@/components/references/ReviewerChip';

import { toast } from '@/components/ui';
import { useIssueAssigneeCandidates } from '@/hooks/useIssueAssigneeCandidates';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type {
    Label,
    RepositoryChangeRequestReference,
    RepositoryIssueReference,
    RepositoryReference,
    RepositoryReferenceDetail,
    RepositoryReferenceReviewer,
    SourceControlReadContext,
    TrackerItemSummary,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { editTrackerItem } from '@/lib/trackers/mutations';
import type { ReviewerStateValue } from '@/lib/source-control/types';
import { cn } from '@/lib/utils';
import { SourceBoardChoicePicker, type BoardChoice } from './SourceBoardChoicePicker';
import { SourceBoardTextChoiceField } from './SourceBoardTextChoiceField';
import { newMutationKey } from './mutationKey';
import { blockerCandidates } from './trackerChoices';
import { claimChangeRequestWrite, releaseChangeRequestWrite, useChangeRequestWrite } from './changeRequestWrites';

const labelChoice = (label: Label): BoardChoice => ({
    id: label.name,
    label: label.name,
    content: <ReferenceLabelChips labels={[{ name: label.name, color: labelColor(label.color) }]} />,
});

const reviewerChoice = (person: RepositoryReferenceReviewer): BoardChoice => ({
    id: person.id,
    label: person.login,
    content: <ReviewerPerson person={person} />,
});

const MetaValue: React.FC<{ empty: boolean; children: React.ReactNode; picker: React.ReactNode }> = ({ empty, children, picker }) => {
    const { t } = useI18n();
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {empty ? <span className="text-muted-foreground">{t('sourceBoard.meta.none')}</span> : children}
            {picker}
        </span>
    );
};

const recordUnlistedLabelWrite = (reference: RepositoryReference, labels: Label[]) => recordLabelWrite(reference, labels, null);

export const SourceBoardLabels: React.FC<{
    reference: RepositoryReference;
    context: SourceControlReadContext;
    onWritten?: (reference: RepositoryReference, labels: Label[]) => void;
    onChanged: () => void;
}> = ({ reference, context, onWritten = recordUnlistedLabelWrite, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const descriptor = useSourceControlProvider(reference.provider);
    const project = { owner: reference.sourceRepo.owner, repo: reference.sourceRepo.repo };
    const repositoryLabels = React.useRef<Label[]>([]);

    const commit = async (labels: string[]) => {
        setBusy(true);
        try {
            const payload = {
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: project.owner, name: project.repo }, number: reference.number },
                labels,
            };
            if (reference.kind === 'pull') await sourceControl.changeRequestSetLabels(payload);
            else if (reference.kind === 'discussion') await sourceControl.discussionSetLabels(payload);
            else await sourceControl.issueSetLabels(payload);
            onWritten(reference, labels.map((name) => (
                reference.labels.find((label) => label.name === name)
                    ?? repositoryLabels.current.find((label) => label.name === name)
                    ?? { name }
            )));
        } catch (error) {
            toast.error(t('sourceBoard.toast.labelsFailed', { reference: referenceNumberLabel(reference, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            onChanged();
        }
    };

    return (
        <MetaValue
            empty={reference.labels.length === 0}
            picker={(
                <SourceBoardChoicePicker
                    ariaLabel={t('sourceBoard.labels.edit')}
                    searchPlaceholder={t('sourceBoard.labels.search')}
                    emptyText={t('sourceBoard.labels.empty')}
                    selected={reference.labels.map((label) => label.name)}
                    selectedChoices={reference.labels.map(labelChoice)}
                    loadChoices={async () => {
                        repositoryLabels.current = await sourceControl.referenceLabels(context, project);
                        return repositoryLabels.current.map(labelChoice);
                    }}
                    onCommit={(labels) => void commit(labels)}
                    busy={busy}
                />
            )}
        >
            <ReferenceLabelChips labels={reference.labels.map((label) => ({ name: label.name, color: labelColor(label.color) }))} />
        </MetaValue>
    );
};

export const SourceBoardReviewerPicker: React.FC<{
    pull: RepositoryChangeRequestReference;
    detail: CachedValue<RepositoryReferenceDetail>;
    context: SourceControlReadContext;
    onChanged: () => void;
}> = ({ pull, detail, context, onChanged }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const reviewers = detail.status === 'ready' ? detail.value.pull?.reviewers ?? [] : null;
    const descriptor = useSourceControlProvider(pull.provider);
    const project = { owner: pull.sourceRepo.owner, repo: pull.sourceRepo.repo };

    const commit = async (ids: string[]) => {
        setBusy(true);
        try {
            await sourceControl.changeRequestSetReviewers({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner: project.owner, name: project.repo }, number: pull.number },
                reviewers: ids,
            });
        } catch (error) {
            toast.error(t('sourceBoard.toast.reviewersFailed', { reference: referenceNumberLabel(pull, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            onChanged();
        }
    };

    if (detail.status === 'error') return null;
    if (!reviewers) return <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;
    if (pull.state !== 'open') return null;
    return (
        <SourceBoardChoicePicker
            ariaLabel={t('sourceBoard.reviewers.edit')}
            searchPlaceholder={t('sourceBoard.reviewers.search')}
            emptyText={t('sourceBoard.reviewers.empty')}
            selected={reviewers.map((person) => person.id)}
            selectedChoices={reviewers.map(reviewerChoice)}
            loadChoices={async () => (await sourceControl.referenceReviewers(context, project))
                // external: https://docs.github.com/en/rest/pulls/review-requests#request-reviewers-for-a-pull-request GitHub refuses review requests to the PR author; GitLab allows them.
                .filter((person) => descriptor.features.authorCanReview || person.login !== pull.author?.login)
                .map(reviewerChoice)}
            onCommit={(ids) => void commit(ids)}
            busy={busy}
        />
    );
};

export const SourceBoardBase: React.FC<{
    pull: RepositoryChangeRequestReference;
    context: SourceControlReadContext;
    onChanged: () => void | Promise<void>;
    sheet?: boolean;
}> = ({ pull, context, onChanged, sheet = false }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const write = useChangeRequestWrite(pull);
    const descriptor = useSourceControlProvider(pull.provider);
    const { owner, repo } = pull.sourceRepo;
    const shown = React.useRef({ head: pull.head, base: pull.base });

    const commit = async (base: string) => {
        if (!claimChangeRequestWrite(pull, 'base')) return;
        try {
            await sourceControl.changeRequestSetBase({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner, name: repo }, number: pull.number, ...shown.current },
                base,
            });
            await onChanged();
        } catch (error) {
            toast.error(t('sourceBoard.base.failed', { reference: referenceNumberLabel(pull, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            releaseChangeRequestWrite(pull);
        }
    };

    return (
        <SourceBoardChoicePicker
            single
            ariaLabel={t('sourceBoard.base.edit')}
            searchPlaceholder={t('sourceBoard.base.search')}
            emptyText={t('sourceBoard.base.empty')}
            selected={[]}
            loadChoices={async () => {
                shown.current = { head: pull.head, base: pull.base };
                const branches = await sourceControl.projectBranches(context, owner, repo);
                return branches
                    .filter((branch) => branch !== pull.base)
                    .map((branch) => ({
                        id: branch,
                        label: branch,
                        content: (
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                                <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="truncate font-mono">{branch}</span>
                            </span>
                        ),
                    }));
            }}
            onCommit={([base]) => void commit(base)}
            busy={write === 'base'}
            disabled={write !== null}
            sheet={sheet}
        />
    );
};

const issueChoice = (issue: TrackerItemSummary): BoardChoice => ({
    id: issue.identifier,
    label: `${issue.identifier} ${issue.title}`,
    content: (
        <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono typography-meta text-muted-foreground">{issue.identifier}</span>
            <span className="truncate">{issue.title}</span>
        </span>
    ),
});

/** A blocker named only by its identifier, for one that left the open list. */
const blockerChoice = (identifier: string): BoardChoice => ({
    id: identifier,
    label: identifier,
    content: <span className="font-mono">{identifier}</span>,
});

/**
 * The issues this one waits on, changed as one set from the project's own open
 * issues. Only identifiers are written: whether they still block is the
 * tracker's answer, computed from their states, so settling a blocker needs no
 * edit here.
 */
export const SourceBoardBlockers: React.FC<{
    item: TrackerItemSummary;
    /** The project the board shows; the issues offered are its own. */
    containerId: string | null;
    onChanged: () => void;
}> = ({ item, containerId, onChanged }) => {
    const { t } = useI18n();
    const { trackers } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const blockers = item.blockedBy ?? [];

    const commit = async (identifiers: string[]) => {
        setBusy(true);
        try {
            // The container travels with the write: identifiers restart in every
            // project, so the number alone could reach another project's issue.
            await editTrackerItem(item.provider, containerId
                ? { id: item.id, containerId, blockedBy: identifiers }
                : { id: item.id, blockedBy: identifiers });
        } catch (error) {
            toast.error(t('sourceBoard.toast.blockersFailed', { identifier: item.identifier }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            onChanged();
        }
    };

    return (
        <MetaValue
            empty={blockers.length === 0}
            picker={(
                <SourceBoardChoicePicker
                    ariaLabel={t('sourceBoard.blockers.edit')}
                    searchPlaceholder={t('sourceBoard.blockers.search')}
                    emptyText={t('sourceBoard.blockers.empty')}
                    selected={blockers}
                    selectedChoices={blockers.map(blockerChoice)}
                    loadChoices={async () => {
                        if (!trackers) return [];
                        const listed = await trackers.list(item.provider, { state: 'open', containerId });
                        if (listed.connected === false) return [];
                        // It never waits on itself: that would block it forever.
                        return blockerCandidates(listed.items, item.identifier).map(issueChoice);
                    }}
                    onCommit={(identifiers) => void commit(identifiers)}
                    busy={busy}
                />
            )}
        >
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono">
                {blockers.map((identifier) => <span key={identifier}>{identifier}</span>)}
            </span>
        </MetaValue>
    );
};

/** No names yet, kept stable so the read below does not restart on every render. */
const NO_NAMES: readonly string[] = [];

/**
 * Who an issue is assigned to. A local issue has no member list, so the value
 * is a name: the project's existing ones are offered, and a new spelling is
 * still possible — the same rule groupings follow, for the same reason (one
 * person spelled two ways is two assignees). Assignment is what the
 * `issue-work` command dispatches on, and it is set here, on the item, rather
 * than in the create form: an issue is usually written before it is owned.
 */
export const SourceBoardAssignee: React.FC<{
    item: TrackerItemSummary;
    /** The project the board shows; the names offered are its own. */
    containerId: string | null;
    onChanged: () => void;
}> = ({ item, containerId, onChanged }) => {
    const { t } = useI18n();
    const { trackers } = useRuntimeAPIs();
    const [names, setNames] = React.useState<readonly string[]>(NO_NAMES);
    const [busy, setBusy] = React.useState(false);
    const name = item.assignee?.name ?? '';

    // The names already in use, from the list's facets: one read when the row
    // is shown, and nothing at all without a runtime API to ask.
    React.useEffect(() => {
        if (!trackers) return;
        let live = true;
        void trackers.list(item.provider, { state: 'all', containerId })
            .then((listed) => {
                if (live && listed.connected !== false) setNames(listed.facets?.assignee ?? NO_NAMES);
            })
            .catch(() => {
                // An unreadable list only costs the suggestions: typing a name
                // still works, so the row stays usable.
            });
        return () => { live = false; };
    }, [trackers, item.provider, containerId]);

    const commit = async (next: string) => {
        setBusy(true);
        try {
            // `null` unassigns: the server drops the key, which reads back as
            // no assignee.
            const assignee = next || null;
            await editTrackerItem(item.provider, containerId
                ? { id: item.id, containerId, assignee }
                : { id: item.id, assignee });
        } catch (error) {
            toast.error(t('sourceBoard.toast.assigneeFailed', { identifier: item.identifier }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setBusy(false);
            onChanged();
        }
    };

    return (
        <MetaValue
            empty={!name}
            picker={(
                <SourceBoardTextChoiceField
                    trigger="icon"
                    ariaLabel={t('sourceBoard.assignee.edit')}
                    value={name}
                    options={names}
                    onChange={(next) => void commit(next)}
                    busy={busy}
                    placeholder={t('sourceBoard.assignee.placeholder')}
                    searchPlaceholder={t('sourceBoard.assignee.search')}
                    emptyText={t('sourceBoard.assignee.empty')}
                    createLabel={(typed) => t('sourceBoard.assignee.create', { name: typed })}
                    clearLabel={t('sourceBoard.assignee.clear')}
                />
            )}
        >
            <span className="truncate">{name}</span>
        </MetaValue>
    );
};

const assigneeChoice = (person: RepositoryReferenceReviewer): BoardChoice => ({
    id: person.id,
    label: person.login,
    content: <ReviewerPerson person={person} />,
});

export const SourceBoardAssignees: React.FC<{
    issue: RepositoryIssueReference;
    detail: CachedValue<RepositoryReferenceDetail>;
    writeAccess?: boolean;
    context: SourceControlReadContext;
    onChanged: () => void | Promise<void>;
    sheet?: boolean;
}> = ({ issue, detail, writeAccess, context, onChanged, sheet = false }) => {
    const { t } = useI18n();
    const { sourceControl } = useRuntimeAPIs();
    const [busy, setBusy] = React.useState(false);
    const assignees = detail.status === 'ready' ? detail.value.assignees ?? null : null;
    const descriptor = useSourceControlProvider(issue.provider);
    const { owner, repo } = issue.sourceRepo;
    const { candidates, setCandidates } = useIssueAssigneeCandidates(context, owner, repo);

    const commit = async (ids: string[]) => {
        setBusy(true);
        try {
            await sourceControl.issueSetAssignees({
                ...context,
                idempotencyKey: newMutationKey(),
                target: { project: { owner, name: repo }, number: issue.number },
                assignees: ids,
            });
        } catch (error) {
            toast.error(t('sourceBoard.assignees.saveFailed', { reference: referenceNumberLabel(issue, descriptor) }), {
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            try {
                await onChanged();
            } finally {
                setBusy(false);
            }
        }
    };

    if (detail.status === 'idle' || detail.status === 'loading') return <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />;
    if (!assignees) return null;
    const editable = descriptor.features.issueAssignees && candidates !== null && writeAccess !== false;
    return (
        <MetaValue
            empty={false}
            picker={editable ? (
                <SourceBoardChoicePicker
                    ariaLabel={t('sourceBoard.assignees.edit')}
                    searchPlaceholder={t('sourceBoard.reviewers.search')}
                    emptyText={t('sourceBoard.reviewers.empty')}
                    selected={assignees.map((person) => person.id)}
                    selectedChoices={assignees.map(assigneeChoice)}
                    loadChoices={async () => {
                        const people = await sourceControl.referenceReviewers(context, { owner, repo }, 'assignee');
                        setCandidates(people);
                        return people.map(assigneeChoice);
                    }}
                    onCommit={(ids) => void commit(ids)}
                    busy={busy}
                    sheet={sheet}
                />
            ) : null}
        >
            {assignees.length === 0
                ? <span className="text-muted-foreground">{t('sourceBoard.assignees.empty')}</span>
                : assignees.map((person) => <ReviewerPerson key={person.id} person={person} />)}
        </MetaValue>
    );
};
