export const PERMISSIONS = [
  'tenant.manage', 'campus.manage', 'user.manage', 'role.manage', 'audit.read',
  'academic.manage', 'academic.read',
  'admissions.read', 'admissions.write', 'admissions.decide', 'admissions.enroll',
  'student.read', 'student.write', 'medical.read', 'medical.write',
  'course.manage', 'course.read_all',
  'hostel.manage', 'hostel.read', 'leave.approve', 'gate.record', 'rollcall.record',
  'incident.report', 'incident.manage', 'safeguarding.manage',
  'attendance.manage', 'attendance.read', 'dismissal.record',
  'finance.manage', 'finance.read', 'finance.approve',
  'grades.approve',
  'transport.manage', 'transport.read', 'transport.operate',
  'library.manage', 'inventory.manage', 'inventory.read', 'inventory.request', 'inventory.approve',
  'hr.manage', 'hr.read', 'payroll.manage', 'payroll.approve', 'counselling.manage', 'security.manage',
  'meals.manage', 'meals.read', 'activities.manage', 'comms.manage', 'tickets.manage',
  'reports.export',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that make an account "privileged" and therefore require MFA. */
export const PRIVILEGED: Permission[] = ['tenant.manage', 'campus.manage', 'user.manage', 'role.manage', 'audit.read', 'admissions.enroll', 'medical.read', 'medical.write', 'safeguarding.manage', 'finance.approve', 'finance.manage', 'inventory.approve', 'payroll.manage', 'payroll.approve', 'hr.manage', 'counselling.manage'];

export interface SystemRole { key: string; name: string; permissions: Permission[] }
const ALL = [...PERMISSIONS];
// Roles with no permissions yet belong to modules not implemented (see docs/REQUIREMENTS_TRACEABILITY.md).
export const SYSTEM_ROLES: SystemRole[] = [
  { key: 'group_admin', name: 'School group administrator', permissions: ALL },
  { key: 'campus_admin', name: 'Campus administrator', permissions: ALL.filter((p) => p !== 'tenant.manage' && p !== 'safeguarding.manage' && p !== 'counselling.manage') },
  { key: 'principal', name: 'Principal', permissions: ['academic.read', 'admissions.read', 'student.read', 'course.read_all', 'audit.read', 'hostel.read', 'incident.manage', 'attendance.read', 'finance.read', 'finance.approve', 'transport.read', 'inventory.read', 'inventory.approve', 'payroll.approve', 'hr.read', 'comms.manage', 'tickets.manage', 'meals.read', 'reports.export'] },
  { key: 'admissions_officer', name: 'Admissions officer', permissions: ['academic.read', 'admissions.read', 'admissions.write', 'admissions.decide', 'admissions.enroll', 'student.read'] },
  { key: 'registrar', name: 'Registrar', permissions: ['reports.export', 'tickets.manage', 'comms.manage', 'academic.manage', 'academic.read', 'student.read', 'student.write', 'admissions.read', 'attendance.manage', 'attendance.read', 'grades.approve'] },
  { key: 'accountant', name: 'Accountant', permissions: ['reports.export', 'student.read', 'finance.manage', 'finance.read', 'academic.read'] },
  { key: 'teacher', name: 'Teacher and class teacher', permissions: ['academic.read', 'incident.report', 'inventory.request', 'activities.manage'] },
  { key: 'exam_coordinator', name: 'Examination coordinator', permissions: ['academic.read', 'grades.approve', 'student.read'] },
  { key: 'lms_admin', name: 'LMS administrator', permissions: ['academic.read', 'course.manage', 'course.read_all'] },
  { key: 'student', name: 'Student', permissions: [] },
  { key: 'parent', name: 'Parent or guardian', permissions: [] },
  { key: 'warden', name: 'Hostel warden and house parent', permissions: ['student.read', 'hostel.manage', 'hostel.read', 'leave.approve', 'gate.record', 'rollcall.record', 'incident.report', 'incident.manage'] },
  { key: 'transport', name: 'Transport manager, driver and attendant', permissions: ['transport.manage', 'transport.read', 'transport.operate', 'student.read'] },
  { key: 'nurse', name: 'Nurse and counsellor', permissions: ['student.read', 'medical.read', 'medical.write', 'counselling.manage'] },
  { key: 'safeguarding_officer', name: 'Safeguarding officer', permissions: ['student.read', 'incident.report', 'incident.manage', 'safeguarding.manage'] },
  { key: 'librarian', name: 'Librarian', permissions: ['library.manage', 'student.read'] },
  { key: 'inventory_manager', name: 'Inventory manager', permissions: ['inventory.manage', 'inventory.read', 'inventory.request'] },
  { key: 'hr_payroll', name: 'HR and payroll staff', permissions: ['hr.manage', 'hr.read', 'payroll.manage'] },
  { key: 'security_staff', name: 'Security and gate staff', permissions: ['student.read', 'gate.record', 'incident.report', 'dismissal.record', 'security.manage'] },
  { key: 'kitchen_manager', name: 'Kitchen manager', permissions: ['meals.manage', 'meals.read'] },
  { key: 'auditor', name: 'Auditor or read-only user', permissions: ['audit.read', 'academic.read', 'student.read', 'admissions.read', 'course.read_all'] },
];
