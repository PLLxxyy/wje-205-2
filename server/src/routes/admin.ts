import { Router, Request, Response } from 'express';
import db from '../db';
import { authMiddleware } from '../auth';

const router = Router();

// All departments queue status (admin)
router.get('/queues', authMiddleware(['admin']), (_req: Request, res: Response) => {
  const today = new Date().toISOString().slice(0, 10);

  const departments = db.prepare('SELECT * FROM departments ORDER BY id').all() as any[];
  const result = departments.map((dept: any) => {
    const doctors = db.prepare(
      'SELECT id, name, title FROM doctors WHERE department_id = ?'
    ).all(dept.id) as any[];

    const doctorDetails = doctors.map((doc: any) => {
      const serving = db.prepare(`
        SELECT a.queue_number, p.name as patient_name
        FROM appointments a JOIN patients p ON a.patient_id = p.id
        WHERE a.doctor_id = ? AND a.date = ? AND a.status = 'serving'
      `).get(doc.id, today) as any;

      const waiting = db.prepare(
        "SELECT COUNT(*) as count FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'waiting'"
      ).get(doc.id, today) as any;

      const completed = db.prepare(
        "SELECT COUNT(*) as count FROM appointments WHERE doctor_id = ? AND date = ? AND status = 'completed'"
      ).get(doc.id, today) as any;

      return {
        ...doc,
        current_number: serving?.queue_number || null,
        current_patient: serving?.patient_name || null,
        waiting: waiting.count,
        completed: completed.count,
      };
    });

    const totalWaiting = doctorDetails.reduce((s: number, d: any) => s + d.waiting, 0);
    const totalCompleted = doctorDetails.reduce((s: number, d: any) => s + d.completed, 0);

    return { ...dept, doctors: doctorDetails, total_waiting: totalWaiting, total_completed: totalCompleted };
  });

  res.json(result);
});

// Daily statistics
router.get('/stats', authMiddleware(['admin']), (req: Request, res: Response) => {
  const { start_date, end_date } = req.query;
  const start = (start_date as string) || new Date().toISOString().slice(0, 10);
  const end = (end_date as string) || start;

  const dailyStats = db.prepare(`
    SELECT a.date, dep.name as department_name, COUNT(*) as total,
      SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN a.status IN ('waiting', 'serving') THEN 1 ELSE 0 END) as pending
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    JOIN departments dep ON d.department_id = dep.id
    WHERE a.date BETWEEN ? AND ?
    GROUP BY a.date, dep.name
    ORDER BY a.date DESC, dep.name
  `).all(start, end);

  const totalStats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting,
      SUM(CASE WHEN status = 'serving' THEN 1 ELSE 0 END) as serving
    FROM appointments
    WHERE date BETWEEN ? AND ?
  `).get(start, end);

  // Per department summary
  const deptSummary = db.prepare(`
    SELECT dep.name as department_name, COUNT(*) as total,
      SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM appointments a
    JOIN doctors d ON a.doctor_id = d.id
    JOIN departments dep ON d.department_id = dep.id
    WHERE a.date BETWEEN ? AND ?
    GROUP BY dep.name ORDER BY total DESC
  `).all(start, end);

  res.json({ daily: dailyStats, total: totalStats, by_department: deptSummary });
});

// List all patients (admin)
router.get('/patients', authMiddleware(['admin']), (_req: Request, res: Response) => {
  const patients = db.prepare('SELECT id, username, name, phone FROM patients ORDER BY id').all();
  res.json(patients);
});

// List all doctors (admin)
router.get('/doctors', authMiddleware(['admin']), (_req: Request, res: Response) => {
  const doctors = db.prepare(`
    SELECT d.id, d.username, d.name, d.title, dep.name as department_name, dep.id as department_id
    FROM doctors d JOIN departments dep ON d.department_id = dep.id
    ORDER BY dep.id, d.id
  `).all();
  res.json(doctors);
});

// ============ Schedule Management ============

// Get schedules with filters (department, date, doctor)
router.get('/schedules', authMiddleware(['admin']), (req: Request, res: Response) => {
  const { department_id, doctor_id, date } = req.query;

  let sql = `
    SELECT ts.id, ts.doctor_id, ts.date, ts.start_time, ts.end_time, ts.max_appointments, ts.current_appointments,
           d.name as doctor_name, d.title as doctor_title,
           dep.id as department_id, dep.name as department_name
    FROM time_slots ts
    JOIN doctors d ON ts.doctor_id = d.id
    JOIN departments dep ON d.department_id = dep.id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (department_id) {
    sql += ' AND dep.id = ?';
    params.push(department_id);
  }
  if (doctor_id) {
    sql += ' AND d.id = ?';
    params.push(doctor_id);
  }
  if (date) {
    sql += ' AND ts.date = ?';
    params.push(date);
  }

  sql += ' ORDER BY dep.id, d.id, ts.date, ts.start_time';

  const schedules = db.prepare(sql).all(...params);
  res.json(schedules);
});

// Get doctors by department (for schedule form)
router.get('/schedules/doctors/:departmentId', authMiddleware(['admin']), (req: Request, res: Response) => {
  const departmentId = Number(req.params.departmentId);
  const doctors = db.prepare(`
    SELECT id, name, title FROM doctors WHERE department_id = ? ORDER BY id
  `).all(departmentId);
  res.json(doctors);
});

// Create a single time slot
router.post('/schedules', authMiddleware(['admin']), (req: Request, res: Response) => {
  const { doctor_id, date, start_time, end_time, max_appointments } = req.body;

  if (!doctor_id || !date || !start_time || !end_time) {
    res.status(400).json({ message: '缺少必要参数' });
    return;
  }

  const max = max_appointments || 10;

  // Check for overlapping slots
  const existing = db.prepare(`
    SELECT * FROM time_slots
    WHERE doctor_id = ? AND date = ?
      AND ((start_time < ? AND end_time > ?)
        OR (start_time < ? AND end_time > ?)
        OR (start_time >= ? AND end_time <= ?))
  `).get(doctor_id, date, end_time, start_time, end_time, start_time, start_time, end_time) as any;

  if (existing) {
    res.status(400).json({ message: '该时段与已有排班冲突' });
    return;
  }

  const result = db.prepare(`
    INSERT INTO time_slots (doctor_id, date, start_time, end_time, max_appointments, current_appointments)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(doctor_id, date, start_time, end_time, max);

  res.json({ id: Number(result.lastInsertRowid), message: '排班创建成功' });
});

// Batch create time slots for a doctor on a date
router.post('/schedules/batch', authMiddleware(['admin']), (req: Request, res: Response) => {
  const { doctor_id, date, slots } = req.body;

  if (!doctor_id || !date || !Array.isArray(slots) || slots.length === 0) {
    res.status(400).json({ message: '缺少必要参数' });
    return;
  }

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  const txn = db.transaction(() => {
    for (const slot of slots) {
      const { start_time, end_time, max_appointments } = slot;
      if (!start_time || !end_time) {
        skipped++;
        continue;
      }

      const max = max_appointments || 10;

      const existing = db.prepare(`
        SELECT id FROM time_slots
        WHERE doctor_id = ? AND date = ?
          AND ((start_time < ? AND end_time > ?)
            OR (start_time < ? AND end_time > ?)
            OR (start_time >= ? AND end_time <= ?))
      `).get(doctor_id, date, end_time, start_time, end_time, start_time, start_time, end_time);

      if (existing) {
        skipped++;
        errors.push(`${start_time}-${end_time} 已存在或冲突`);
        continue;
      }

      db.prepare(`
        INSERT INTO time_slots (doctor_id, date, start_time, end_time, max_appointments, current_appointments)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(doctor_id, date, start_time, end_time, max);
      created++;
    }
  });
  txn();

  res.json({
    message: `批量处理完成：成功 ${created} 条，跳过 ${skipped} 条`,
    created,
    skipped,
    errors,
  });
});

// Delete a time slot
router.delete('/schedules/:id', authMiddleware(['admin']), (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const slot = db.prepare('SELECT * FROM time_slots WHERE id = ?').get(id) as any;
  if (!slot) {
    res.status(404).json({ message: '时段不存在' });
    return;
  }

  // Check if there are existing appointments
  const apptCount = db.prepare(
    "SELECT COUNT(*) as count FROM appointments WHERE slot_id = ? AND status != 'cancelled'"
  ).get(id) as any;

  if (apptCount.count > 0) {
    res.status(400).json({ message: `该时段已有 ${apptCount.count} 个有效预约，无法删除` });
    return;
  }

  db.prepare('DELETE FROM time_slots WHERE id = ?').run(id);
  res.json({ message: '排班已删除' });
});

// Delete all slots for a doctor on a date (no appointments only)
router.delete('/schedules', authMiddleware(['admin']), (req: Request, res: Response) => {
  const { doctor_id, date } = req.body;

  if (!doctor_id || !date) {
    res.status(400).json({ message: '缺少参数' });
    return;
  }

  const slotsWithAppt = db.prepare(`
    SELECT ts.id, COUNT(a.id) as appt_count
    FROM time_slots ts
    LEFT JOIN appointments a ON a.slot_id = ts.id AND a.status != 'cancelled'
    WHERE ts.doctor_id = ? AND ts.date = ?
    GROUP BY ts.id
    HAVING appt_count > 0
  `).all(doctor_id, date) as any[];

  if (slotsWithAppt.length > 0) {
    res.status(400).json({ message: `有 ${slotsWithAppt.length} 个时段存在有效预约，无法删除` });
    return;
  }

  const result = db.prepare(
    'DELETE FROM time_slots WHERE doctor_id = ? AND date = ?'
  ).run(doctor_id, date);

  res.json({ message: `已删除 ${result.changes} 个时段` });
});

export default router;
