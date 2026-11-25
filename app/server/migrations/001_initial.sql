-- Серверное хранилище «Дриповщицы», версия 1.
-- Строки IndexedDB переносятся без изменений: первичный ключ id и полный JSON
-- записи в data. Внешние ключи намеренно не создаются: старые данные допускают
-- ссылки на отсутствующие записи (например, production_task_id после замены
-- задач миграцией схемы v5). Связи покрыты индексами по тем же полям, что
-- индексировал Dexie; ограничения целостности добавятся вместе с серверными
-- операциями после проверки импорта. Булевы флаги индексируются с приведением
-- к boolean — запросы должны использовать то же выражение.

CREATE TABLE lots (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX lots_country_idx ON lots ((data ->> 'country'));
CREATE INDEX lots_roast_date_idx ON lots ((data ->> 'roastDate'));

CREATE TABLE allocations (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX allocations_lot_id_idx ON allocations ((data ->> 'lotId'));

CREATE TABLE production_tasks (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX production_tasks_lot_id_idx ON production_tasks ((data ->> 'lotId'));
CREATE INDEX production_tasks_status_idx ON production_tasks ((data ->> 'status'));
CREATE INDEX production_tasks_planned_date_idx ON production_tasks ((data ->> 'plannedDate'));

CREATE TABLE production_entries (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX production_entries_task_id_idx ON production_entries ((data ->> 'taskId'));
CREATE INDEX production_entries_created_at_idx ON production_entries ((data ->> 'createdAt'));

CREATE TABLE inventory (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX inventory_source_lot_id_idx ON inventory ((data ->> 'sourceLotId'));
CREATE INDEX inventory_production_task_id_idx ON inventory ((data ->> 'productionTaskId'));
CREATE INDEX inventory_format_id_idx ON inventory ((data ->> 'formatId'));
CREATE INDEX inventory_purpose_idx ON inventory ((data ->> 'purpose'));
CREATE INDEX inventory_manufactured_at_idx ON inventory ((data ->> 'manufacturedAt'));

CREATE TABLE inventory_transactions (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX inventory_transactions_lot_id_idx ON inventory_transactions ((data ->> 'inventoryLotId'));
CREATE INDEX inventory_transactions_created_at_idx ON inventory_transactions ((data ->> 'createdAt'));

CREATE TABLE reservations (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX reservations_assembly_task_id_idx ON reservations ((data ->> 'assemblyTaskId'));
CREATE INDEX reservations_inventory_lot_id_idx ON reservations ((data ->> 'inventoryLotId'));
CREATE INDEX reservations_status_idx ON reservations ((data ->> 'status'));

CREATE TABLE expected_reservations (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX expected_reservations_assembly_task_id_idx ON expected_reservations ((data ->> 'assemblyTaskId'));
CREATE INDEX expected_reservations_production_task_id_idx ON expected_reservations ((data ->> 'productionTaskId'));

CREATE TABLE aliases (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX aliases_inventory_lot_id_idx ON aliases ((data ->> 'inventoryLotId'));

CREATE TABLE sheet_connections (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);

CREATE TABLE imported_compositions (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX imported_compositions_connection_id_idx ON imported_compositions ((data ->> 'sheetConnectionId'));
CREATE INDEX imported_compositions_enabled_idx ON imported_compositions (((data ->> 'enabled')::boolean));

CREATE TABLE manual_compositions (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX manual_compositions_enabled_idx ON manual_compositions (((data ->> 'enabled')::boolean));

CREATE TABLE assembly_plans (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX assembly_plans_date_idx ON assembly_plans ((data ->> 'date'));
CREATE INDEX assembly_plans_status_idx ON assembly_plans ((data ->> 'status'));

CREATE TABLE assembly_tasks (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX assembly_tasks_plan_id_idx ON assembly_tasks ((data ->> 'planId'));
CREATE INDEX assembly_tasks_status_idx ON assembly_tasks ((data ->> 'status'));
CREATE INDEX assembly_tasks_production_date_idx ON assembly_tasks ((data ->> 'productionDate'));

CREATE TABLE assembly_reports (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX assembly_reports_task_id_idx ON assembly_reports ((data ->> 'taskId'));
CREATE INDEX assembly_reports_employee_id_idx ON assembly_reports ((data ->> 'employeeId'));
CREATE INDEX assembly_reports_created_at_idx ON assembly_reports ((data ->> 'createdAt'));

CREATE TABLE employees (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX employees_active_idx ON employees (((data ->> 'active')::boolean));

CREATE TABLE production_days (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX production_days_date_idx ON production_days ((data ->> 'date'));
CREATE INDEX production_days_status_idx ON production_days ((data ->> 'status'));

CREATE TABLE daily_reports (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX daily_reports_date_idx ON daily_reports ((data ->> 'date'));

CREATE TABLE warnings (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX warnings_read_idx ON warnings (((data ->> 'read')::boolean));
CREATE INDEX warnings_type_idx ON warnings ((data ->> 'type'));
CREATE INDEX warnings_created_at_idx ON warnings ((data ->> 'createdAt'));

CREATE TABLE adjustments (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX adjustments_entity_id_idx ON adjustments ((data ->> 'entityId'));

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX audit_events_entity_id_idx ON audit_events ((data ->> 'entityId'));
CREATE INDEX audit_events_created_at_idx ON audit_events ((data ->> 'createdAt'));

CREATE TABLE settings (
  id text PRIMARY KEY,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
