/** Defines the repository path selected for project and work-item checkout queries. */

/* —— Project checkout path —— */

export const PROJECT_REPOSITORY_PATH_SQL = `COALESCE(
  (
    SELECT primary_repository.path
    FROM repositories primary_repository
    WHERE primary_repository.project_id=project.project_id
      AND primary_repository.is_primary=1
  ),
  project.repo_path
)`;

/* —— Work-item checkout path —— */

export const WORK_ITEM_REPOSITORY_PATH_SQL = `COALESCE(
  (
    SELECT selected_repository.path
    FROM repositories selected_repository
    WHERE selected_repository.repository_id=work_item.repository_id
  ),
  (
    SELECT ${PROJECT_REPOSITORY_PATH_SQL}
    FROM projects project
    WHERE project.project_id=work_item.resolved_project_id
  )
)`;

export const WORK_ITEM_REPOSITORY_NAME_SQL = `COALESCE(
  (
    SELECT selected_repository.name
    FROM repositories selected_repository
    WHERE selected_repository.repository_id=work_item.repository_id
  ),
  (
    SELECT primary_repository.name
    FROM repositories primary_repository
    WHERE primary_repository.project_id=work_item.resolved_project_id
      AND primary_repository.is_primary=1
  ),
  (
    SELECT project.name
    FROM projects project
    WHERE project.project_id=work_item.resolved_project_id
  )
)`;

/* —— Resolved repository identity —— */

/**
 * A work item's repository, resolving null to the project's primary. Requires
 * `work_items work_item` in scope.
 */
export const WORK_ITEM_REPOSITORY_ID_SQL = `COALESCE(
  work_item.repository_id,
  (
    SELECT primary_repository.repository_id
    FROM repositories primary_repository
    WHERE primary_repository.project_id=work_item.resolved_project_id
      AND primary_repository.is_primary=1
  )
)`;

/**
 * An agent's repository, resolving null to its project's primary — never "any".
 * Requires `agents agent` in scope.
 */
export const AGENT_REPOSITORY_ID_SQL = `COALESCE(
  agent.repository_id,
  (
    SELECT primary_repository.repository_id
    FROM repositories primary_repository
    WHERE primary_repository.project_id=agent.project_id
      AND primary_repository.is_primary=1
  )
)`;
