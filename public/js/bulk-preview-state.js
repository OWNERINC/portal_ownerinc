export function createBulkPreviewState() {
  let generation = 0; let file = null; let rows = [];
  return {
    select(nextFile) { file = nextFile; rows = []; return ++generation; },
    begin() { rows = []; return { generation: ++generation, file }; },
    accept(ticket, report) {
      if (!ticket?.file || ticket.file !== file || ticket.generation !== generation) return false;
      rows = Array.isArray(report?.rows) ? structuredClone(report.rows) : []; return true;
    },
    current(ticket) { return !!ticket && ticket.file === file && ticket.generation === generation; },
    confirmedRows() { return structuredClone(rows); },
    reset() { file = null; rows = []; generation += 1; },
  };
}
