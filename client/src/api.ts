const BASE = '/api';

let token: string | null = localStorage.getItem('token');

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

export function getToken() { return token; }

async function request(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '请求失败');
  return data;
}

export const api = {
  // Auth
  registerPatient: (body: any) => request('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  loginPatient: (body: any) => request('/auth/login/patient', { method: 'POST', body: JSON.stringify(body) }),
  loginDoctor: (body: any) => request('/auth/login/doctor', { method: 'POST', body: JSON.stringify(body) }),
  loginAdmin: (body: any) => request('/auth/login/admin', { method: 'POST', body: JSON.stringify(body) }),
  getMe: () => request('/auth/me'),

  // Departments
  getDepartments: () => request('/departments'),
  getDepartment: (id: number) => request(`/departments/${id}`),
  getAllDoctors: () => request('/departments/doctors/all'),

  // Appointments
  getSlots: (doctorId: number, date: string) => request(`/appointments/slots?doctor_id=${doctorId}&date=${date}`),
  bookAppointment: (body: any) => request('/appointments', { method: 'POST', body: JSON.stringify(body) }),
  getMyAppointments: () => request('/appointments/mine'),
  cancelAppointment: (id: number) => request(`/appointments/${id}/cancel`, { method: 'PUT' }),

  // Doctor
  getDoctorAppointments: () => request('/doctor/appointments'),
  callNext: () => request('/doctor/call-next', { method: 'POST' }),
  writeDiagnosis: (id: number, diagnosis: string) =>
    request(`/doctor/appointments/${id}/diagnosis`, { method: 'PUT', body: JSON.stringify({ diagnosis }) }),

  // Queue
  getQueueDepartment: (id: number) => request(`/queue/department/${id}`),
  getQueueOverview: () => request('/queue/overview'),
  getQueueDisplay: (id: number) => request(`/queue/display/${id}`),

  // Admin
  getAdminQueues: () => request('/admin/queues'),
  getAdminStats: (startDate?: string, endDate?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set('start_date', startDate);
    if (endDate) params.set('end_date', endDate);
    return request(`/admin/stats?${params.toString()}`);
  },
  getAdminDoctors: () => request('/admin/doctors'),

  // Admin Schedule Management
  getSchedules: (params?: { department_id?: number; doctor_id?: number; date?: string }) => {
    const search = new URLSearchParams();
    if (params?.department_id) search.set('department_id', String(params.department_id));
    if (params?.doctor_id) search.set('doctor_id', String(params.doctor_id));
    if (params?.date) search.set('date', params.date);
    return request(`/admin/schedules?${search.toString()}`);
  },
  getSchedulesDoctors: (departmentId: number) => request(`/admin/schedules/doctors/${departmentId}`),
  createSchedule: (body: { doctor_id: number; date: string; start_time: string; end_time: string; max_appointments?: number }) =>
    request('/admin/schedules', { method: 'POST', body: JSON.stringify(body) }),
  createScheduleBatch: (body: { doctor_id: number; date: string; slots: Array<{ start_time: string; end_time: string; max_appointments?: number }> }) =>
    request('/admin/schedules/batch', { method: 'POST', body: JSON.stringify(body) }),
  deleteSchedule: (id: number) => request(`/admin/schedules/${id}`, { method: 'DELETE' }),
  deleteDoctorDateSchedules: (body: { doctor_id: number; date: string }) =>
    request('/admin/schedules', { method: 'DELETE', body: JSON.stringify(body) }),
};
