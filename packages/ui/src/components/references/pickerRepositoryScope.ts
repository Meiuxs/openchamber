
import type { RepositoryChoice, RepositoryScope } from '@/lib/source-control/repositoryScope';

import type { ReferencePickerSource } from './referencePickerItems';

export const DEFAULT_REPOSITORY_CHOICE: RepositoryChoice = { path: null, all: undefined };

/** Only a repository source carries a repository scope; a tracker's directory is unrelated. */
export const scopesRepositories = (source: ReferencePickerSource, nestedRepositories: boolean): boolean => (
    nestedRepositories && source === 'repository'
);

export const listDirectoryOf = (scope: RepositoryScope | null, directory: string | null): string | null => (
    scope?.directory ?? directory
);

export const listDirectoriesOf = (scope: RepositoryScope | null): readonly string[] | null => (
    scope?.all ? scope.repositories : null
);

export const repositoryChoiceFromPicker = (repository: string | null): RepositoryChoice => (
    repository === null ? { path: null, all: true } : { path: repository, all: false }
);
