require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const MongoStore = require('connect-mongo');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const mongoUri = process.env.MONGODB_URI || (process.env.NODE_ENV === 'production' ? '' : 'mongodb://127.0.0.1:27017/naujan_mhs_serms');
const trustProxyHops = process.env.TRUST_PROXY_HOPS;
const roles = ['student', 'teacher', 'registrar', 'principal'];

if (trustProxyHops !== undefined && trustProxyHops !== '') {
  const hops = Number(trustProxyHops);
  if (!Number.isSafeInteger(hops) || hops < 0) throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
  app.set('trust proxy', hops);
}

const schemaOptions = { timestamps: true, strict: true };
const accountSchema = new mongoose.Schema({
  role: { type: String, enum: roles, required: true },
  identifier: { type: String, required: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  registrationStatus: { type: String, enum: ['Pending Approval', 'Approved', 'Rejected'], default: 'Approved' },
  registrationReviewNote: { type: String, default: '', maxlength: 500 },
  active: { type: Boolean, default: true }
}, schemaOptions);
accountSchema.index({ role: 1, identifier: 1 }, { unique: true });

const enrollmentSchema = new mongoose.Schema({
  lrn: { type: String, required: true, unique: true, trim: true },
  trackingCode: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  grade: { type: String, required: true },
  strand: { type: String, default: 'JHS Regular' },
  section: { type: String, default: '' },
  brgy: { type: String, default: '' },
  guardian: { type: String, default: '' },
  contact: { type: String, default: '' },
  average: { type: Number, min: 0, max: 100 },
  dateOfBirth: String,
  sex: String,
  lastSchool: String,
  psaVerified: { type: Boolean, default: false },
  status: { type: String, enum: ['Pending Review', 'Officially Enrolled', 'Returned for Revision'], default: 'Pending Review' },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' }
}, schemaOptions);

const documentRequestSchema = new mongoose.Schema({
  tracking: { type: String, required: true, unique: true },
  lrn: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  docType: { type: String, required: true },
  purpose: { type: String, required: true },
  contact: String,
  status: { type: String, enum: ['Pending Processing', 'Processing', 'Ready for Claim', 'Dispatched', 'Returned for Revision'], default: 'Pending Processing' },
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' }
}, schemaOptions);

const attendanceSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  date: { type: String, required: true },
  section: String,
  entries: { type: [mongoose.Schema.Types.Mixed], default: [] }
}, schemaOptions);
attendanceSchema.index({ teacher: 1, date: 1, section: 1 }, { unique: true });

const gradeSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  quarter: { type: Number, default: 1 },
  grade: String,
  section: String,
  students: { type: [mongoose.Schema.Types.Mixed], default: [] },
  status: { type: String, enum: ['Draft', 'Submitted', 'Approved & Locked', 'Returned for Revision'], default: 'Draft' },
  reviewNote: String,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
  reviewedAt: Date
}, schemaOptions);
gradeSchema.index({ teacher: 1, quarter: 1, section: 1, grade: 1 }, { unique: true });

const anecdotalSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  student: { type: String, required: true },
  date: { type: String, required: true },
  narrative: { type: String, required: true, maxlength: 5000 },
  actionTaken: String,
  referral: String
}, schemaOptions);

const facultySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  rank: String,
  department: String,
  load: String,
  active: { type: Boolean, default: true }
}, schemaOptions);

const teacherRosterSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  section: { type: String, required: true, trim: true, maxlength: 120 },
  learnerLrns: { type: [String], default: [] },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true }
}, schemaOptions);
teacherRosterSchema.index({ teacher: 1, section: 1 }, { unique: true });

const broadcastSchema = new mongoose.Schema({
  type: { type: String, required: true },
  message: { type: String, required: true, maxlength: 5000 },
  sms: { type: Boolean, default: false },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true }
}, schemaOptions);

const auditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
  action: { type: String, required: true },
  subject: String,
  details: { type: mongoose.Schema.Types.Mixed, default: {} }
}, schemaOptions);

const recoverySchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  otpHash: { type: String, required: true },
  resetTokenHash: String,
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  verified: { type: Boolean, default: false }
}, schemaOptions);
recoverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const helpdeskSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  identifier: String,
  department: String,
  contact: String,
  reason: { type: String, required: true, maxlength: 5000 },
  status: { type: String, enum: ['Open', 'In Progress', 'Resolved'], default: 'Open' }
}, schemaOptions);

const publicPortalContentSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'public' },
  schoolYear: { type: String, default: '2026–2027', maxlength: 20 },
  heroTitle: { type: String, default: 'Empowering Mindoro’s Youth with', maxlength: 140 },
  heroAccent: { type: String, default: 'Quality Basic Education', maxlength: 80 },
  heroDescription: { type: String, default: 'The online portal for Naujan Municipal High School. Submit an enrollment application and track its status using the tracking code provided after submission.', maxlength: 600 },
  enrollmentOpen: { type: Boolean, default: true },
  enrollmentInstructions: { type: String, default: 'SERMS accepts enrollment applications for registrar review. It does not perform PSA verification or synchronize with DepEd LIS.', maxlength: 600 },
  announcements: {
    type: [{
      category: { type: String, maxlength: 40 },
      date: { type: String, maxlength: 40 },
      title: { type: String, maxlength: 120 },
      body: { type: String, maxlength: 500 }
    }],
    default: []
  },
  contactAddress: { type: String, default: 'Poblacion, Naujan, Oriental Mindoro, 5204 Philippines', maxlength: 240 },
  contactPhone: { type: String, default: '(043) 288-7810', maxlength: 80 },
  contactEmail: { type: String, default: 'naujanmhs.301648@deped.gov.ph', maxlength: 254 },
  officeHours: { type: String, default: 'Mon - Fri: 8:00 AM - 5:00 PM', maxlength: 120 },
  enrolledLearners: { type: String, default: '', maxlength: 20 },
  facultyPersonnel: { type: String, default: '', maxlength: 20 },
  promotionRate: { type: String, default: '', maxlength: 10 },
  logoData: { type: String, default: '' }
}, schemaOptions);

const Account = mongoose.model('Account', accountSchema);
const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
const DocumentRequest = mongoose.model('DocumentRequest', documentRequestSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const GradeSubmission = mongoose.model('GradeSubmission', gradeSchema);
const AnecdotalRecord = mongoose.model('AnecdotalRecord', anecdotalSchema);
const Faculty = mongoose.model('Faculty', facultySchema);
const TeacherRoster = mongoose.model('TeacherRoster', teacherRosterSchema);
const Broadcast = mongoose.model('Broadcast', broadcastSchema);
const AuditEvent = mongoose.model('AuditEvent', auditSchema);
const RecoveryChallenge = mongoose.model('RecoveryChallenge', recoverySchema);
const HelpdeskTicket = mongoose.model('HelpdeskTicket', helpdeskSchema);
const PublicPortalContent = mongoose.model('PublicPortalContent', publicPortalContentSchema);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const studentRegistrationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
const publicSubmissionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const trackingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/recovery', authLimiter);

const sessionSecret = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'local-development-secret-change-before-deploying')
  .update(crypto.randomBytes(32))
  .digest('hex');

app.use(require('express-session')({
  name: 'serms.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: mongoUri ? MongoStore.create({ mongoUrl: mongoUri, collectionName: 'sessions' }) : undefined,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireAuth(...allowedRoles) {
  return async (req, res, next) => {
    if (!req.session.account) return next(httpError(401, 'Sign in to access this resource.'));
    if (allowedRoles.length && !allowedRoles.includes(req.session.account.role)) return next(httpError(403, 'Your account does not have permission to do that.'));
    if (['teacher', 'registrar'].includes(req.session.account.role)) {
      try {
        const active = await Account.exists({ _id: req.session.account.id, active: true });
        if (!active) {
          return req.session.destroy(error => {
            if (error) return next(error);
            res.clearCookie('serms.sid');
            next(httpError(401, 'This staff account is inactive. Sign in again or contact the principal.'));
          });
        }
      } catch (error) {
        return next(error);
      }
    }
    next();
  };
}

function requireFields(source, fields) {
  for (const field of fields) {
    if (typeof source[field] !== 'string' || !source[field].trim()) {
      throw httpError(400, `${field} is required.`);
    }
  }
}

function publicAccount(account) {
  return { id: account._id, role: account.role, identifier: account.identifier, name: account.name, email: account.email || '' };
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvResponse(res, filename, headers, rows) {
  const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${csv}`);
}

async function audit(req, action, subject, details = {}) {
  await AuditEvent.create({
    actor: req.session.account?.id,
    action,
    subject,
    details
  });
}

function accountCanRecover(account) {
  return Boolean(account && account.active && (
    account.role !== 'student' ||
    account.registrationStatus === 'Approved' ||
    account.registrationStatus === undefined
  ));
}

function makeTrackingCode() {
  return `ENR-${new Date().getFullYear()}-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
}

function makeDocumentCode() {
  return `DOC-${new Date().getFullYear()}-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
}

async function getPublicPortalContent() {
  const content = await PublicPortalContent.findOne({ key: 'public' }).lean();
  return content || {
    schoolYear: '2026–2027',
    heroTitle: 'Empowering Mindoro’s Youth with',
    heroAccent: 'Quality Basic Education',
    heroDescription: 'The online portal for Naujan Municipal High School. Submit an enrollment application and track its status using the tracking code provided after submission.',
    enrollmentOpen: true,
    enrollmentInstructions: 'SERMS accepts enrollment applications for registrar review. It does not perform PSA verification or synchronize with DepEd LIS.',
    announcements: [
      { category: 'Enrollment', date: 'SERMS feature', title: 'Online enrollment applications', body: 'Submit learner details through the enrollment form. The application is stored for registrar review.' },
      { category: 'Registrar', date: 'SERMS feature', title: 'Private tracking codes', body: "Use the tracking code shown after submission to view a record's current status. Searching by LRN is not supported." },
      { category: 'Information', date: 'SERMS feature', title: 'Application status updates', body: 'The portal displays the latest status saved by the registrar. It does not verify external records or assign sections.' }
    ],
    contactAddress: 'Poblacion, Naujan, Oriental Mindoro, 5204 Philippines',
    contactPhone: '(043) 288-7810',
    contactEmail: 'naujanmhs.301648@deped.gov.ph',
    officeHours: 'Mon - Fri: 8:00 AM - 5:00 PM',
    enrolledLearners: '',
    facultyPersonnel: '',
    promotionRate: '',
    logoData: ''
  };
}

app.get('/api/health', (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'database-unavailable' });
});

app.get('/api/public/summary', async (req, res, next) => {
  try {
    const [enrolled, pending] = await Promise.all([
      Enrollment.countDocuments({ status: 'Officially Enrolled' }),
      Enrollment.countDocuments({ status: 'Pending Review' })
    ]);
    res.json({ enrolled, pending });
  } catch (error) { next(error); }
});

app.get('/api/public/content', async (req, res, next) => {
  try {
    const content = await getPublicPortalContent();
    res.json({ content: { ...content, _id: undefined, key: undefined, __v: undefined } });
  } catch (error) { next(error); }
});

app.put('/api/principal/public-content', requireAuth('principal'), async (req, res, next) => {
  try {
    const allowedFields = [
      'schoolYear', 'heroTitle', 'heroAccent', 'heroDescription', 'enrollmentOpen', 'enrollmentInstructions',
      'announcements',       'contactAddress', 'contactPhone', 'contactEmail', 'officeHours', 'enrolledLearners',
      'facultyPersonnel', 'promotionRate', 'logoData'
    ];
    if (Object.keys(req.body).some(field => !allowedFields.includes(field))) {
      throw httpError(400, 'The public portal content contains an unsupported field.');
    }
    for (const field of ['schoolYear', 'heroTitle', 'heroAccent', 'heroDescription', 'enrollmentInstructions', 'contactAddress', 'contactPhone', 'contactEmail', 'officeHours', 'enrolledLearners', 'facultyPersonnel', 'promotionRate']) {
      if (typeof req.body[field] !== 'string') throw httpError(400, `${field} must be text.`);
    }
    const limits = {
      schoolYear: 20, heroTitle: 140, heroAccent: 80, heroDescription: 600, enrollmentInstructions: 600,
      contactAddress: 240, contactPhone: 80, contactEmail: 254, officeHours: 120,
      enrolledLearners: 20, facultyPersonnel: 20, promotionRate: 10
    };
    for (const [field, max] of Object.entries(limits)) {
      if (req.body[field].trim().length > max) throw httpError(400, `${field} must be ${max} characters or fewer.`);
    }
    if (!req.body.schoolYear.trim() || !req.body.heroTitle.trim() || !req.body.heroAccent.trim() || !req.body.heroDescription.trim() || !req.body.enrollmentInstructions.trim()) {
      throw httpError(400, 'School year, homepage heading and description, and enrollment instructions are required.');
    }
    if (typeof req.body.enrollmentOpen !== 'boolean') throw httpError(400, 'Enrollment status must be open or closed.');
    if (!/^\d{0,9}$/.test(req.body.enrolledLearners) || !/^\d{0,9}$/.test(req.body.facultyPersonnel)) {
      throw httpError(400, 'Learner and faculty statistics must be whole numbers.');
    }
    if (req.body.promotionRate && !/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)%?$/.test(req.body.promotionRate)) {
      throw httpError(400, 'Promotion rate must be a percentage from 0 to 100.');
    }
    if (req.body.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.contactEmail.trim())) {
      throw httpError(400, 'Enter a valid contact email address.');
    }
    if (!Array.isArray(req.body.announcements) || req.body.announcements.length !== 3) {
      throw httpError(400, 'Enter exactly three public announcements.');
    }
    const announcements = req.body.announcements.map((item, index) => {
      if (!item || typeof item !== 'object' || ['category', 'date', 'title', 'body'].some(field => typeof item[field] !== 'string')) {
        throw httpError(400, `Announcement ${index + 1} is incomplete.`);
      }
      const announcement = Object.fromEntries(['category', 'date', 'title', 'body'].map(field => [field, item[field].trim()]));
      const lengths = { category: 40, date: 40, title: 120, body: 500 };
      for (const [field, max] of Object.entries(lengths)) {
        if (announcement[field].length > max) throw httpError(400, `Announcement ${index + 1} ${field} must be ${max} characters or fewer.`);
      }
      if (!announcement.category || !announcement.date || !announcement.title || !announcement.body) {
        throw httpError(400, `Announcement ${index + 1} requires a category, date, title, and message.`);
      }
      return announcement;
    });
    if (typeof req.body.logoData !== 'string') throw httpError(400, 'Upload a PNG, JPEG, or WebP logo image.');
    let logoData = req.body.logoData;
    if (logoData) {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(logoData);
      if (!match) throw httpError(400, 'Logo must be a PNG, JPEG, or WebP image.');
      const image = Buffer.from(match[2], 'base64');
      if (!image.length || image.length > 750 * 1024) throw httpError(400, 'Logo image must be no larger than 750 KB.');
      const signatures = {
        png: image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        jpeg: image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff,
        webp: image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP'
      };
      if (!signatures[match[1]]) throw httpError(400, 'The uploaded file is not a valid image of the selected type.');
      logoData = `data:image/${match[1]};base64,${image.toString('base64')}`;
    }
    const update = {
      schoolYear: req.body.schoolYear.trim(),
      heroTitle: req.body.heroTitle.trim(),
      heroAccent: req.body.heroAccent.trim(),
      heroDescription: req.body.heroDescription.trim(),
      enrollmentOpen: req.body.enrollmentOpen,
      enrollmentInstructions: req.body.enrollmentInstructions.trim(),
      announcements,
      contactAddress: req.body.contactAddress.trim(),
      contactPhone: req.body.contactPhone.trim(),
      contactEmail: req.body.contactEmail.trim().toLowerCase(),
      officeHours: req.body.officeHours.trim(),
      enrolledLearners: req.body.enrolledLearners.trim(),
      facultyPersonnel: req.body.facultyPersonnel.trim(),
      promotionRate: req.body.promotionRate.trim().replace(/%$/, ''),
      logoData
    };
    const content = await PublicPortalContent.findOneAndUpdate(
      { key: 'public' },
      { $set: update, $setOnInsert: { key: 'public' } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    await audit(req, 'public_portal.content.updated', 'Public portal', {
      schoolYear: content.schoolYear,
      enrollmentOpen: content.enrollmentOpen,
      logoUpdated: Boolean(logoData)
    });
    res.json({ content: { ...content, _id: undefined, key: undefined, __v: undefined } });
  } catch (error) { next(error); }
});

app.get('/api/student/dashboard', requireAuth('student'), async (req, res, next) => {
  try {
    const account = await Account.findById(req.session.account.id).select('identifier name active');
    if (!account || !account.active) throw httpError(401, 'This student account is no longer active. Sign in again.');
    const enrollment = await Enrollment.findOne({
      $or: [{ submittedBy: account._id }, { lrn: account.identifier }]
    }).select('lrn trackingCode status grade strand section createdAt').lean();
    let grades = [];
    let attendance = [];
    if (enrollment?.status === 'Officially Enrolled') {
      const [gradeRecords, attendanceRecords] = await Promise.all([
        GradeSubmission.find({ status: 'Approved & Locked', 'students.lrn': enrollment.lrn })
          .select('grade quarter section students reviewedAt')
          .sort({ quarter: -1, reviewedAt: -1 })
          .limit(40)
          .lean(),
        Attendance.find({ 'entries.lrn': enrollment.lrn })
          .select('date section entries')
          .sort({ date: -1 })
          .limit(90)
          .lean()
      ]);
      const scoreFields = ['ww1', 'ww2', 'ww3', 'pt1', 'pt2', 'pt3', 'exam'];
      grades = gradeRecords.map(record => {
        const student = record.students.find(entry => entry.lrn === enrollment.lrn);
        const scores = {};
        for (const field of scoreFields) {
          if (student?.[field] !== undefined && student[field] !== null && student[field] !== '' && Number.isFinite(Number(student[field]))) {
            scores[field] = Number(student[field]);
          }
        }
        return {
          learningArea: record.grade,
          quarter: record.quarter,
          section: record.section,
          scores,
          reviewedAt: record.reviewedAt
        };
      }).filter(record => Object.keys(record.scores).length > 0);
      attendance = attendanceRecords.map(record => ({
        date: record.date,
        section: record.section,
        status: record.entries.find(entry => entry.lrn === enrollment.lrn)?.status
      })).filter(record => ['Present', 'Late', 'Absent', 'Excused'].includes(record.status));
    }
    res.json({
      account: { name: account.name, identifier: account.identifier },
      enrollment: enrollment ? {
        trackingCode: enrollment.trackingCode,
        status: enrollment.status,
        grade: enrollment.grade,
        strand: enrollment.strand,
        section: enrollment.section,
        submittedAt: enrollment.createdAt
      } : null,
      grades,
      attendance
    });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    requireFields(req.body, ['identifier', 'password', 'role']);
    if (!roles.includes(req.body.role)) throw httpError(400, 'Select a valid account type.');
    const identifier = req.body.identifier.trim().toLowerCase();
    const account = await Account.findOne({ role: req.body.role, identifier });
    if (!account || !(await bcrypt.compare(req.body.password, account.passwordHash))) throw httpError(401, 'The account details were not recognized.');
    if (account.role === 'student' && account.registrationStatus === 'Pending Approval') {
      throw httpError(403, 'Your student account is awaiting registrar approval.');
    }
    if (account.role === 'student' && account.registrationStatus === 'Rejected') {
      throw httpError(403, `Your student account registration was not approved.${account.registrationReviewNote ? ` Registrar note: ${account.registrationReviewNote}` : ' Contact the registrar for assistance.'}`);
    }
    if (!account.active) throw httpError(401, 'The account details were not recognized.');
    req.session.account = publicAccount(account);
    await audit(req, 'auth.login', account.identifier);
    res.json({ account: req.session.account });
  } catch (error) { next(error); }
});

app.post('/api/student-registrations', studentRegistrationLimiter, async (req, res, next) => {
  try {
    requireFields(req.body, ['lrn', 'name', 'email', 'password', 'confirmPassword']);
    const lrn = req.body.lrn.trim();
    const name = req.body.name.trim();
    const email = req.body.email.trim().toLowerCase();
    const password = req.body.password;
    if (!/^\d{12}$/.test(lrn)) throw httpError(400, 'Enter a valid 12-digit Learner Reference Number (LRN).');
    if (name.length > 120) throw httpError(400, 'Full name must be 120 characters or fewer.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw httpError(400, 'Enter a valid email address.');
    if (password !== req.body.confirmPassword) throw httpError(400, 'The passwords do not match.');
    if (password.length < 12 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      throw httpError(400, 'Use a password with 12–128 characters, including upper- and lowercase letters, a number, and a symbol.');
    }
    const account = await Account.create({
      role: 'student',
      identifier: lrn,
      passwordHash: await bcrypt.hash(password, 12),
      name,
      email,
      active: false,
      registrationStatus: 'Pending Approval'
    });
    res.status(201).json({
      registration: {
        identifier: account.identifier,
        status: account.registrationStatus
      }
    });
  } catch (error) {
    if (error.code === 11000) return next(httpError(409, 'A student account or registration already exists for this LRN. Contact the registrar if you need help.'));
    next(error);
  }
});

app.get('/api/auth/me', (req, res) => {
  res.json({ account: req.session.account || null });
});

app.get('/api/auth/profile', requireAuth('teacher', 'registrar', 'principal'), async (req, res, next) => {
  try {
    const account = await Account.findById(req.session.account.id).select('role identifier name email active');
    if (!account || !account.active) throw httpError(401, 'This account is no longer active. Sign in again.');
    res.json({ account: publicAccount(account) });
  } catch (error) { next(error); }
});

app.patch('/api/auth/profile', requireAuth('teacher', 'registrar', 'principal'), async (req, res, next) => {
  try {
    const allowedFields = ['name', 'email', 'currentPassword', 'newPassword'];
    if (Object.keys(req.body).some(field => !allowedFields.includes(field))) {
      throw httpError(400, 'The profile contains an unsupported field.');
    }
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) throw httpError(400, 'Full name is required.');
    const name = req.body.name.trim();
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (name.length > 120) throw httpError(400, 'Name must be 120 characters or fewer.');
    if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw httpError(400, 'Enter a valid email address or leave the email field blank.');
    }

    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    if (newPassword) {
      if (!currentPassword) throw httpError(400, 'Enter your current password to change it.');
      if (newPassword.length < 8 || newPassword.length > 128 || !/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
        throw httpError(400, 'Use a password with 8–128 characters, including upper- and lowercase letters, a number, and a symbol.');
      }
    } else if (currentPassword) {
      throw httpError(400, 'Enter a new password to update your password.');
    }

    const account = await Account.findById(req.session.account.id);
    if (!account || !account.active) throw httpError(401, 'This account is no longer active. Sign in again.');
    if (newPassword && !(await bcrypt.compare(currentPassword, account.passwordHash))) {
      throw httpError(400, 'Your current password is incorrect.');
    }

    account.name = name;
    account.email = email;
    const changes = ['name', 'email'];
    if (newPassword) {
      account.passwordHash = await bcrypt.hash(newPassword, 12);
      changes.push('password');
    }
    await account.save();
    req.session.account = publicAccount(account);
    await audit(req, 'account.profile_updated', account.identifier, { fields: changes });
    res.json({ account: req.session.account });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('serms.sid');
    res.status(204).end();
  });
});

app.post('/api/enrollments', publicSubmissionLimiter, async (req, res, next) => {
  try {
    requireFields(req.body, ['lrn', 'lastName', 'firstName', 'grade']);
    if (!(await getPublicPortalContent()).enrollmentOpen) throw httpError(403, 'Online enrollment applications are currently closed.');
    const optionalTextFields = ['middleName', 'dateOfBirth', 'sex', 'barangay', 'strand', 'lastSchool', 'guardian', 'contact'];
    for (const field of ['lrn', 'lastName', 'firstName', 'grade', ...optionalTextFields]) {
      if (req.body[field] !== undefined && typeof req.body[field] !== 'string') throw httpError(400, `${field} must be text.`);
    }
    if (!/^\d{12}$/.test(req.body.lrn.trim())) throw httpError(400, 'LRN must contain 12 digits.');
    if (req.session.account?.role === 'student' && req.body.lrn.trim() !== req.session.account.identifier) {
      throw httpError(403, 'Your student account can only submit an application using its own LRN.');
    }
    const grade = req.body.grade.trim();
    if (!/^Grade (?:[7-9]|1[0-2])$/.test(grade)) throw httpError(400, 'Select a valid grade from Grade 7 to Grade 12.');
    for (const field of ['lastName', 'firstName', 'middleName', 'barangay', 'strand', 'lastSchool', 'guardian', 'contact']) {
      if (req.body[field] && req.body[field].trim().length > 120) throw httpError(400, `${field} must be 120 characters or fewer.`);
    }
    if (req.body.sex && !['Female', 'Male'].includes(req.body.sex)) throw httpError(400, 'Select a valid sex value.');
    if (req.body.dateOfBirth) {
      const dateOfBirth = new Date(`${req.body.dateOfBirth}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.dateOfBirth) || Number.isNaN(dateOfBirth.getTime()) || dateOfBirth.toISOString().slice(0, 10) !== req.body.dateOfBirth) {
        throw httpError(400, 'Enter a valid date of birth.');
      }
    }
    let average;
    if (req.body.average !== undefined && req.body.average !== '') {
      if (!['string', 'number'].includes(typeof req.body.average)) throw httpError(400, 'General average must be a number from 0 to 100.');
      average = Number(req.body.average);
      if (!Number.isFinite(average) || average < 0 || average > 100) throw httpError(400, 'General average must be a number from 0 to 100.');
    }
    const name = `${req.body.lastName.trim()}, ${req.body.firstName.trim()}${req.body.middleName ? ` ${req.body.middleName.trim()}` : ''}`;
    const enrollment = await Enrollment.create({
      lrn: req.body.lrn.trim(),
      trackingCode: makeTrackingCode(),
      name,
      grade,
      strand: ['Grade 11', 'Grade 12'].includes(grade) ? (req.body.strand?.trim() || 'Unassigned') : 'JHS Regular',
      brgy: req.body.barangay?.trim() || '',
      guardian: req.body.guardian?.trim() || '',
      contact: req.body.contact?.trim() || '',
      average,
      dateOfBirth: req.body.dateOfBirth?.trim() || '',
      sex: req.body.sex || '',
      lastSchool: req.body.lastSchool?.trim() || '',
      status: 'Pending Review',
      submittedBy: req.session.account?.id
    });
    await audit(req, 'enrollment.created', enrollment.lrn, { trackingCode: enrollment.trackingCode });
    res.status(201).json({ enrollment: { lrn: enrollment.lrn, trackingCode: enrollment.trackingCode, name: enrollment.name, status: enrollment.status } });
  } catch (error) {
    if (error.code === 11000) return next(httpError(409, 'An enrollment record already exists for this LRN.'));
    next(error);
  }
});

app.get('/api/enrollments/track/:reference', trackingLimiter, async (req, res, next) => {
  try {
    const reference = req.params.reference.trim().toUpperCase();
    if (!/^(?:ENR|DOC)-\d{4}-[A-F0-9]{6,32}$/.test(reference)) throw httpError(404, 'No record matched that tracking code.');
    const enrollment = await Enrollment.findOne({ trackingCode: reference }).select('trackingCode status createdAt');
    if (enrollment) return res.json({ trackingCode: enrollment.trackingCode, status: enrollment.status, submittedAt: enrollment.createdAt, recordType: 'enrollment' });
    const request = await DocumentRequest.findOne({ tracking: reference.toUpperCase() }).select('tracking status createdAt');
    if (!request) throw httpError(404, 'No record matched that reference.');
    res.json({ trackingCode: request.tracking, status: request.status, submittedAt: request.createdAt, recordType: 'document' });
  } catch (error) { next(error); }
});

app.get('/api/enrollments', requireAuth('registrar', 'principal'), async (req, res) => {
  res.json({ enrollments: await Enrollment.find().sort({ createdAt: -1 }).limit(500).lean() });
});

app.patch('/api/enrollments/:lrn/status', requireAuth('registrar', 'principal'), async (req, res, next) => {
  try {
    if (!['Pending Review', 'Officially Enrolled', 'Returned for Revision'].includes(req.body.status)) throw httpError(400, 'Invalid enrollment status.');
    const enrollment = await Enrollment.findOneAndUpdate({ lrn: req.params.lrn }, { status: req.body.status }, { new: true });
    if (!enrollment) throw httpError(404, 'Enrollment record not found.');
    await audit(req, 'enrollment.status.updated', enrollment.lrn, { status: enrollment.status });
    res.json({ enrollment });
  } catch (error) { next(error); }
});

app.post('/api/documents', requireAuth('student', 'registrar'), async (req, res, next) => {
  try {
    requireFields(req.body, ['lrn', 'name', 'docType', 'purpose']);
    const request = await DocumentRequest.create({
      tracking: makeDocumentCode(), lrn: req.body.lrn.trim(), name: req.body.name.trim(),
      docType: req.body.docType.trim(), purpose: req.body.purpose.trim(), contact: req.body.contact || ''
    });
    await audit(req, 'document.requested', request.tracking, { lrn: request.lrn });
    res.status(201).json({ request });
  } catch (error) { next(error); }
});

app.get('/api/documents', requireAuth('registrar', 'principal'), async (req, res) => {
  res.json({ requests: await DocumentRequest.find().sort({ createdAt: -1 }).limit(500).lean() });
});

app.get('/api/registrar/overview', requireAuth('registrar'), async (req, res, next) => {
  try {
    const [enrollmentsByStatus, enrollmentsByGrade, documentsByStatus, documentsByType, documentRequestCount] = await Promise.all([
      Enrollment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Enrollment.aggregate([
        { $match: { status: 'Officially Enrolled' } },
        { $group: { _id: '$grade', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      DocumentRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      DocumentRequest.aggregate([{ $group: { _id: '$docType', count: { $sum: 1 } } }]),
      DocumentRequest.countDocuments()
    ]);
    const enrollmentStatuses = { 'Pending Review': 0, 'Officially Enrolled': 0, 'Returned for Revision': 0 };
    const documentStatuses = { 'Pending Processing': 0, Processing: 0, 'Ready for Claim': 0, Dispatched: 0, 'Returned for Revision': 0 };
    enrollmentsByStatus.forEach(item => { enrollmentStatuses[item._id] = item.count; });
    documentsByStatus.forEach(item => { documentStatuses[item._id] = item.count; });
    res.json({
      enrollmentStatuses,
      enrollmentCount: enrollmentStatuses['Officially Enrolled'],
      enrollmentsByGrade,
      documentRequestCount,
      documentStatuses,
      documentsByType
    });
  } catch (error) { next(error); }
});

app.patch('/api/documents/:tracking/status', requireAuth('registrar'), async (req, res, next) => {
  try {
    const allowed = ['Pending Processing', 'Processing', 'Ready for Claim', 'Dispatched', 'Returned for Revision'];
    if (!allowed.includes(req.body.status)) throw httpError(400, 'Invalid document request status.');
    const request = await DocumentRequest.findOneAndUpdate({ tracking: req.params.tracking }, { status: req.body.status, processedBy: req.session.account.id }, { new: true });
    if (!request) throw httpError(404, 'Document request not found.');
    await audit(req, 'document.status.updated', request.tracking, { status: request.status });
    res.json({ request });
  } catch (error) { next(error); }
});

app.get('/api/registrar/student-registrations', requireAuth('registrar'), async (req, res) => {
  const registrations = await Account.find({
    role: 'student',
    registrationStatus: { $in: ['Pending Approval', 'Approved', 'Rejected'] }
  }).select('name identifier email registrationStatus registrationReviewNote createdAt updatedAt')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  res.json({ registrations });
});

app.patch('/api/registrar/student-registrations/:id', requireAuth('registrar'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(400, 'Invalid student registration identifier.');
    if (!['Approved', 'Rejected'].includes(req.body.status)) throw httpError(400, 'Choose approval or rejection for this student registration.');
    const reviewNote = typeof req.body.reviewNote === 'string' ? req.body.reviewNote.trim() : '';
    if (reviewNote.length > 500) throw httpError(400, 'Registrar note must be 500 characters or fewer.');
    if (req.body.status === 'Rejected' && !reviewNote) throw httpError(400, 'Enter a reason before rejecting a student registration.');
    const account = await Account.findOneAndUpdate(
      { _id: req.params.id, role: 'student', registrationStatus: 'Pending Approval' },
      {
        $set: {
          registrationStatus: req.body.status,
          registrationReviewNote: reviewNote,
          active: req.body.status === 'Approved'
        }
      },
      { new: true, runValidators: true }
    ).select('name identifier email registrationStatus registrationReviewNote');
    if (!account) {
      const exists = await Account.exists({ _id: req.params.id, role: 'student' });
      if (!exists) throw httpError(404, 'Student registration not found.');
      throw httpError(409, 'This registration has already been reviewed.');
    }
    await audit(req, `student_registration.${req.body.status.toLowerCase()}`, account.identifier);
    res.json({ registration: account });
  } catch (error) { next(error); }
});

app.get('/api/registrar/reports/:report.csv', requireAuth('registrar'), async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (req.params.report === 'enrollments') {
      const records = await Enrollment.find().select('lrn name grade strand section status createdAt').sort({ grade: 1, name: 1 }).limit(10000).lean();
      return csvResponse(res, `nmhs-enrollment-register-${today}.csv`,
        ['LRN', 'Learner Name', 'Grade', 'Strand', 'Section', 'Enrollment Status', 'Submitted At'],
        records.map(item => [item.lrn, item.name, item.grade, item.strand, item.section, item.status, item.createdAt?.toISOString?.() || '']));
    }
    if (req.params.report === 'documents') {
      const records = await DocumentRequest.find().select('tracking lrn name docType purpose status createdAt').sort({ createdAt: -1 }).limit(10000).lean();
      return csvResponse(res, `nmhs-document-requests-${today}.csv`,
        ['Tracking Code', 'LRN', 'Learner Name', 'Document Type', 'Purpose', 'Status', 'Filed At'],
        records.map(item => [item.tracking, item.lrn, item.name, item.docType, item.purpose, item.status, item.createdAt?.toISOString?.() || '']));
    }
    throw httpError(404, 'That report is not available from the records currently stored in SERMS.');
  } catch (error) { next(error); }
});

async function currentTeacherRosterMap(teacherId) {
  const assignments = await TeacherRoster.find({ teacher: teacherId }).select('section learnerLrns').lean();
  const assignedLrns = [...new Set(assignments.flatMap(assignment => assignment.learnerLrns))];
  const enrolled = assignedLrns.length
    ? await Enrollment.find({ lrn: { $in: assignedLrns }, status: 'Officially Enrolled' }).distinct('lrn')
    : [];
  const official = new Set(enrolled);
  return new Map(assignments.map(assignment => [
    assignment.section,
    new Set(assignment.learnerLrns.filter(lrn => official.has(lrn)))
  ]));
}

async function validateAssignedLearners(teacherId, section, entries) {
  const assignment = await TeacherRoster.findOne({ teacher: teacherId, section }).select('learnerLrns').lean();
  if (!assignment) throw httpError(403, 'You are not assigned to this class section.');
  const lrns = entries.map(entry => typeof entry?.lrn === 'string' ? entry.lrn.trim() : '');
  if (lrns.some(lrn => !/^\d{12}$/.test(lrn)) || new Set(lrns).size !== lrns.length) {
    throw httpError(400, 'Each learner must have a unique, valid 12-digit LRN.');
  }
  const assigned = new Set(assignment.learnerLrns);
  if (lrns.some(lrn => !assigned.has(lrn))) throw httpError(403, 'One or more learners are not assigned to this class section.');
  const enrolled = lrns.length
    ? await Enrollment.find({ lrn: { $in: lrns }, status: 'Officially Enrolled' }).select('lrn name').lean()
    : [];
  if (enrolled.length !== lrns.length) throw httpError(400, 'Learners must remain officially enrolled to be included in class records.');
  return new Map(enrolled.map(learner => [learner.lrn, learner.name]));
}

app.post('/api/teacher/attendance', requireAuth('teacher'), async (req, res, next) => {
  try {
    requireFields(req.body, ['date', 'section']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) throw httpError(400, 'Attendance date must use YYYY-MM-DD format.');
    if (!Array.isArray(req.body.entries) || req.body.entries.length === 0 || req.body.entries.length > 1000) throw httpError(400, 'Attendance entries must include between 1 and 1,000 learners.');
    const attendanceStatuses = ['Present', 'Late', 'Absent', 'Excused', 'Unmarked'];
    for (const entry of req.body.entries) {
      if (!entry || typeof entry.lrn !== 'string' || !entry.lrn.trim() || typeof entry.name !== 'string' || !entry.name.trim() || !attendanceStatuses.includes(entry.status)) {
        throw httpError(400, 'Each attendance entry requires a learner name, LRN, and valid attendance status.');
      }
    }
    const officialLearners = await validateAssignedLearners(req.session.account.id, req.body.section.trim(), req.body.entries);
    const entries = req.body.entries.map(entry => ({
      lrn: entry.lrn.trim(),
      name: officialLearners.get(entry.lrn.trim()),
      status: entry.status
    }));
    const date = req.body.date;
    const attendance = await Attendance.findOneAndUpdate(
      { teacher: req.session.account.id, date, section: req.body.section.trim() },
      { teacher: req.session.account.id, date, section: req.body.section.trim(), entries },
      { new: true, upsert: true, runValidators: true }
    );
    await audit(req, 'attendance.saved', date, { count: attendance.entries.length });
    res.json({ attendance });
  } catch (error) { next(error); }
});

app.get('/api/teacher/attendance', requireAuth('teacher'), async (req, res) => {
  const learnersBySection = await currentTeacherRosterMap(req.session.account.id);
  const records = await Attendance.find({ teacher: req.session.account.id, section: { $in: [...learnersBySection.keys()] } })
    .sort({ date: -1 })
    .limit(90)
    .lean();
  const attendance = records.map(record => ({
    ...record,
    entries: record.entries.filter(entry => learnersBySection.get(record.section)?.has(entry.lrn))
  }));
  res.json({ attendance });
});

app.get('/api/teacher/rosters', requireAuth('teacher'), async (req, res) => {
  const assignments = await TeacherRoster.find({ teacher: req.session.account.id }).sort({ section: 1 }).lean();
  const assignedLrns = [...new Set(assignments.flatMap(assignment => assignment.learnerLrns))];
  const learners = await Enrollment.find({ lrn: { $in: assignedLrns }, status: 'Officially Enrolled' })
    .select('lrn name grade strand section brgy')
    .sort({ name: 1 })
    .lean();
  const byLrn = new Map(learners.map(learner => [learner.lrn, learner]));
  res.json({
    rosters: assignments.map(assignment => ({
      section: assignment.section,
      learners: assignment.learnerLrns.map(lrn => byLrn.get(lrn)).filter(Boolean)
    }))
  });
});

app.post('/api/teacher/grades', requireAuth('teacher'), async (req, res, next) => {
  try {
    requireFields(req.body, ['grade', 'section']);
    if (req.body.grade.trim().length > 120) throw httpError(400, 'Subject or learning area must be 120 characters or fewer.');
    if (!Array.isArray(req.body.students) || req.body.students.length === 0 || req.body.students.length > 1000) throw httpError(400, 'Grade entries must include between 1 and 1,000 learners.');
    const quarter = Number(req.body.quarter);
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 3) throw httpError(400, 'Term must be an integer from 1 to 3.');
    const scoreLimits = { ww1: 25, ww2: 25, ww3: 50, pt1: 30, pt2: 30, pt3: 40, exam: 50 };
    for (const student of req.body.students) {
      if (!student || typeof student.lrn !== 'string' || !student.lrn.trim() || typeof student.name !== 'string' || !student.name.trim()) {
        throw httpError(400, 'Each grade entry requires a learner name and LRN.');
      }
      for (const [field, maximum] of Object.entries(scoreLimits)) {
        if (student[field] !== undefined && (!Number.isFinite(Number(student[field])) || Number(student[field]) < 0 || Number(student[field]) > maximum)) {
          throw httpError(400, `${field} must be a number between 0 and ${maximum}.`);
        }
      }
    }
    const officialLearners = await validateAssignedLearners(req.session.account.id, req.body.section.trim(), req.body.students);
    const students = req.body.students.map(student => {
      const entry = { lrn: student.lrn.trim(), name: officialLearners.get(student.lrn.trim()) };
      for (const field of Object.keys(scoreLimits)) {
        if (student[field] !== undefined && student[field] !== '') entry[field] = Number(student[field]);
      }
      return entry;
    });
    const key = { teacher: req.session.account.id, quarter, section: req.body.section.trim(), grade: req.body.grade.trim() };
    const current = await GradeSubmission.findOne(key).select('status');
    if (current?.status === 'Approved & Locked') throw httpError(409, 'This grade submission is signed and locked and cannot be changed.');
    const status = req.body.status === 'Submitted' || current?.status === 'Submitted' ? 'Submitted' : 'Draft';
    const update = { ...key, students, status };
    const grade = current
      ? await GradeSubmission.findOneAndUpdate({ ...key, status: { $ne: 'Approved & Locked' } }, update, { new: true, runValidators: true })
      : await GradeSubmission.create(update);
    if (!grade) throw httpError(409, 'This grade submission was signed and locked before the update could be saved.');
    await audit(req, `grades.${status.toLowerCase()}`, String(grade._id));
    res.status(status === 'Draft' ? 200 : 201).json({ submission: grade });
  } catch (error) {
    if (error.code === 11000) return next(httpError(409, 'A grade submission already exists for this teacher, subject, term, and section.'));
    next(error);
  }
});

app.get('/api/grades', requireAuth('teacher', 'registrar', 'principal'), async (req, res) => {
  if (req.session.account.role !== 'teacher') {
    return res.json({ submissions: await GradeSubmission.find().populate('teacher', 'name identifier').sort({ updatedAt: -1 }).limit(500).lean() });
  }
  const learnersBySection = await currentTeacherRosterMap(req.session.account.id);
  const records = await GradeSubmission.find({
    teacher: req.session.account.id,
    section: { $in: [...learnersBySection.keys()] }
  }).populate('teacher', 'name identifier').sort({ updatedAt: -1 }).limit(500).lean();
  const submissions = records.map(record => ({
    ...record,
    students: record.students.filter(student => learnersBySection.get(record.section)?.has(student.lrn))
  }));
  res.json({ submissions });
});

app.patch('/api/grades/:id/review', requireAuth('registrar', 'principal'), async (req, res, next) => {
  try {
    if (!['Approved & Locked', 'Returned for Revision'].includes(req.body.status)) throw httpError(400, 'Invalid review status.');
    const submission = await GradeSubmission.findOneAndUpdate({ _id: req.params.id, status: { $in: ['Submitted', 'Returned for Revision'] } }, {
      status: req.body.status,
      reviewNote: typeof req.body.note === 'string' ? req.body.note.slice(0, 1000) : '',
      reviewedBy: req.session.account.id,
      reviewedAt: new Date()
    }, { new: true });
    if (!submission) {
      const exists = await GradeSubmission.exists({ _id: req.params.id });
      throw httpError(exists ? 409 : 404, exists ? 'This grade submission is already signed and locked.' : 'Grade submission not found.');
    }
    await audit(req, 'grades.reviewed', String(submission._id), { status: submission.status });
    res.json({ submission });
  } catch (error) { next(error); }
});

app.post('/api/grades/review/batch', requireAuth('principal'), async (req, res, next) => {
  try {
    const result = await GradeSubmission.updateMany(
      { status: 'Submitted' },
      { $set: { status: 'Approved & Locked', reviewedBy: req.session.account.id, reviewedAt: new Date() } }
    );
    await audit(req, 'grades.batch.approved', 'Submitted grade records', { count: result.modifiedCount });
    res.json({ approved: result.modifiedCount });
  } catch (error) { next(error); }
});

app.post('/api/teacher/anecdotal', requireAuth('teacher'), async (req, res, next) => {
  try {
    requireFields(req.body, ['student', 'date', 'narrative']);
    if (!/^\d{12}$/.test(req.body.student.trim())) throw httpError(400, 'Select an assigned learner with a valid 12-digit LRN.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) throw httpError(400, 'Anecdotal record date must use YYYY-MM-DD format.');
    const assignment = await TeacherRoster.findOne({
      teacher: req.session.account.id,
      learnerLrns: req.body.student.trim()
    }).select('_id').lean();
    if (!assignment) throw httpError(403, 'You may create anecdotal records only for learners assigned to you.');
    const learner = await Enrollment.findOne({ lrn: req.body.student.trim(), status: 'Officially Enrolled' }).select('lrn').lean();
    if (!learner) throw httpError(400, 'The learner must remain officially enrolled to create an anecdotal record.');
    const record = await AnecdotalRecord.create({
      teacher: req.session.account.id, student: req.body.student.trim(), date: req.body.date,
      narrative: req.body.narrative.trim(), actionTaken: req.body.actionTaken || '', referral: req.body.referral || ''
    });
    await audit(req, 'anecdotal.created', String(record._id), { student: record.student });
    res.status(201).json({ record });
  } catch (error) { next(error); }
});

app.get('/api/teacher/anecdotal', requireAuth('teacher'), async (req, res) => {
  const rosters = await currentTeacherRosterMap(req.session.account.id);
  const assignedLrns = [...new Set([...rosters.values()].flatMap(learners => [...learners]))];
  const records = await AnecdotalRecord.find({ teacher: req.session.account.id, student: { $in: assignedLrns } })
    .sort({ createdAt: -1 }).limit(100).lean();
  res.json({ records });
});

app.get('/api/teacher/reports/attendance.csv', requireAuth('teacher'), async (req, res, next) => {
  try {
    const learnersBySection = await currentTeacherRosterMap(req.session.account.id);
    const records = await Attendance.find({
      teacher: req.session.account.id,
      section: { $in: [...learnersBySection.keys()] }
    }).sort({ date: -1 }).limit(1000).lean();
    const rows = records.flatMap(record => record.entries
      .filter(entry => learnersBySection.get(record.section)?.has(entry.lrn))
      .map(entry => [record.date, record.section, entry.lrn, entry.name, entry.status]));
    csvResponse(res, `nmhs-teacher-attendance-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Section', 'LRN', 'Learner Name', 'Attendance Status'], rows);
  } catch (error) { next(error); }
});

app.get('/api/principal/faculty', requireAuth('principal'), async (req, res) => {
  res.json({ faculty: await Faculty.find().sort({ name: 1 }).lean() });
});

app.get('/api/principal/overview', requireAuth('principal'), async (req, res, next) => {
  try {
    const [enrollmentsByGrade, enrollmentCount, activeFaculty, activeStaff, submissionsByStatus] = await Promise.all([
      Enrollment.aggregate([
        { $match: { status: 'Officially Enrolled' } },
        { $group: { _id: '$grade', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Enrollment.countDocuments({ status: 'Officially Enrolled' }),
      Faculty.countDocuments({ active: true }),
      Account.aggregate([
        { $match: { active: true, role: { $in: ['teacher', 'registrar'] } } },
        { $group: { _id: '$role', count: { $sum: 1 } } }
      ]),
      GradeSubmission.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);
    const staff = { teacher: 0, registrar: 0 };
    const submissions = { Draft: 0, Submitted: 0, 'Approved & Locked': 0, 'Returned for Revision': 0 };
    activeStaff.forEach(item => { staff[item._id] = item.count; });
    submissionsByStatus.forEach(item => { submissions[item._id] = item.count; });
    res.json({ enrollmentCount, enrollmentsByGrade, activeFaculty, staff, submissions });
  } catch (error) { next(error); }
});

app.get('/api/principal/accounts', requireAuth('principal'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.role !== undefined) {
      if (!['teacher', 'registrar'].includes(req.query.role)) throw httpError(400, 'Staff account role must be teacher or registrar.');
      filter.role = req.query.role;
    } else {
      filter.role = { $in: ['teacher', 'registrar'] };
    }
    const accounts = await Account.find(filter).select('role identifier name email active createdAt').sort({ role: 1, name: 1 }).limit(1000).lean();
    res.json({ accounts: accounts.map(account => ({ ...publicAccount(account), active: account.active, createdAt: account.createdAt })) });
  } catch (error) { next(error); }
});

app.get('/api/principal/rosters/learners', requireAuth('principal'), async (req, res) => {
  const learners = await Enrollment.find({ status: 'Officially Enrolled' })
    .select('lrn name grade strand section')
    .sort({ name: 1 })
    .limit(5000)
    .lean();
  res.json({ learners });
});

app.get('/api/principal/rosters', requireAuth('principal'), async (req, res) => {
  const rosters = await TeacherRoster.find()
    .populate('teacher', 'name identifier active')
    .sort({ section: 1 })
    .lean();
  res.json({
    rosters: rosters.map(roster => ({
      id: roster._id,
      teacher: roster.teacher ? {
        id: roster.teacher._id,
        name: roster.teacher.name,
        identifier: roster.teacher.identifier,
        active: roster.teacher.active
      } : null,
      section: roster.section,
      learnerLrns: roster.learnerLrns
    }))
  });
});

app.put('/api/principal/rosters', requireAuth('principal'), async (req, res, next) => {
  try {
    requireFields(req.body, ['teacherId', 'section']);
    if (!mongoose.isValidObjectId(req.body.teacherId)) throw httpError(400, 'Select a valid teacher account.');
    if (!Array.isArray(req.body.learnerLrns) || req.body.learnerLrns.length > 1000) throw httpError(400, 'Select no more than 1,000 learners.');
    const learnerLrns = [...new Set(req.body.learnerLrns.map(lrn => typeof lrn === 'string' ? lrn.trim() : ''))];
    if (learnerLrns.some(lrn => !/^\d{12}$/.test(lrn))) throw httpError(400, 'Each selected learner must have a valid 12-digit LRN.');
    const teacher = await Account.findOne({ _id: req.body.teacherId, role: 'teacher', active: true }).select('_id');
    if (!teacher) throw httpError(404, 'Active teacher account not found.');
    const activeLearners = learnerLrns.length
      ? await Enrollment.find({ lrn: { $in: learnerLrns }, status: 'Officially Enrolled' }).select('lrn').lean()
      : [];
    if (activeLearners.length !== learnerLrns.length) throw httpError(400, 'Only officially enrolled learners can be assigned.');
    const roster = await TeacherRoster.findOneAndUpdate(
      { teacher: teacher._id, section: req.body.section.trim() },
      { teacher: teacher._id, section: req.body.section.trim(), learnerLrns, assignedBy: req.session.account.id },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await audit(req, 'teacher.roster.assigned', roster.section, { teacher: String(teacher._id), learnerCount: learnerLrns.length });
    res.json({ roster: { id: roster._id, teacher: String(teacher._id), section: roster.section, learnerLrns: roster.learnerLrns } });
  } catch (error) {
    if (error.code === 11000) return next(httpError(409, 'A class roster with that section name already exists for this teacher.'));
    next(error);
  }
});

app.patch('/api/principal/accounts/:id/status', requireAuth('principal'), async (req, res, next) => {
  try {
    if (typeof req.body.active !== 'boolean') throw httpError(400, 'Account status must be active or inactive.');
    const account = await Account.findOneAndUpdate(
      { _id: req.params.id, role: { $in: ['teacher', 'registrar'] } },
      { active: req.body.active },
      { new: true, runValidators: true }
    );
    if (!account) throw httpError(404, 'Teacher or registrar account not found.');
    await audit(req, req.body.active ? 'account.activated' : 'account.deactivated', account.identifier, { role: account.role });
    res.json({ account: { ...publicAccount(account), active: account.active } });
  } catch (error) { next(error); }
});

app.get('/api/principal/reports/:report.csv', requireAuth('principal'), async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (req.params.report === 'enrollments') {
      const records = await Enrollment.find().select('lrn name grade strand section status createdAt').sort({ grade: 1, name: 1 }).limit(10000).lean();
      return csvResponse(res, `nmhs-enrollment-register-${today}.csv`,
        ['LRN', 'Learner Name', 'Grade', 'Strand', 'Section', 'Enrollment Status', 'Submitted At'],
        records.map(item => [item.lrn, item.name, item.grade, item.strand, item.section, item.status, item.createdAt?.toISOString?.() || '']));
    }
    if (req.params.report === 'attendance') {
      const records = await Attendance.find().populate('teacher', 'name identifier').sort({ date: -1 }).limit(10000).lean();
      const rows = records.flatMap(record => {
        const totals = (record.entries || []).reduce((counts, entry) => {
          const status = String(entry.status || 'Unmarked');
          counts[status] = (counts[status] || 0) + 1;
          return counts;
        }, {});
        return Object.entries(totals).map(([status, count]) => [
          record.date, record.teacher?.name, record.teacher?.identifier, record.section, status, count
        ]);
      });
      return csvResponse(res, `nmhs-attendance-summary-${today}.csv`,
        ['Date', 'Teacher', 'Username', 'Section', 'Attendance Status', 'Learner Count'], rows);
    }
    if (req.params.report === 'grades') {
      const records = await GradeSubmission.find().populate('teacher', 'name identifier').sort({ updatedAt: -1 }).limit(10000).lean();
      return csvResponse(res, `nmhs-grade-submissions-${today}.csv`,
        ['Term', 'Grade Level', 'Section', 'Teacher', 'Username', 'Status', 'Learner Count', 'Last Updated'],
        records.map(item => [item.quarter, item.grade, item.section, item.teacher?.name, item.teacher?.identifier, item.status, item.students?.length || 0, item.updatedAt?.toISOString?.() || '']));
    }
    if (req.params.report === 'audit') {
      const records = await AuditEvent.find().populate('actor', 'name identifier role').sort({ createdAt: -1 }).limit(10000).lean();
      return csvResponse(res, `nmhs-audit-log-${today}.csv`,
        ['Timestamp', 'User', 'Username', 'Role', 'Action', 'Subject', 'Details'],
        records.map(item => [item.createdAt?.toISOString?.() || '', item.actor?.name || 'System', item.actor?.identifier || '', item.actor?.role || '', item.action, item.subject, JSON.stringify(item.details || {})]));
    }
    throw httpError(404, 'That report is not available from the records currently stored in SERMS.');
  } catch (error) { next(error); }
});

app.post('/api/principal/accounts', requireAuth('principal'), async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'identifier', 'password', 'role']);
    if (!['teacher', 'registrar'].includes(req.body.role)) {
      throw httpError(400, 'Principal accounts can only be created for teachers and registrars.');
    }
    const name = req.body.name.trim();
    const identifier = req.body.identifier.trim().toLowerCase();
    const password = req.body.password;
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (name.length > 120) throw httpError(400, 'Name must be 120 characters or fewer.');
    if (!/^[a-z0-9._-]{3,50}$/.test(identifier)) {
      throw httpError(400, 'Username must be 3–50 characters using letters, numbers, dots, underscores, or hyphens.');
    }
    if (password.length < 8 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      throw httpError(400, 'Use a password with 8–128 characters, including upper- and lowercase letters, a number, and a symbol.');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw httpError(400, 'Enter a valid email address or leave the email field blank.');
    }
    const account = await Account.create({
      role: req.body.role,
      identifier,
      passwordHash: await bcrypt.hash(password, 12),
      name,
      email
    });
    await audit(req, 'account.created', identifier, { role: account.role });
    res.status(201).json({ account: publicAccount(account) });
  } catch (error) { next(error); }
});

app.post('/api/principal/faculty', requireAuth('principal'), async (req, res, next) => {
  try {
    requireFields(req.body, ['name']);
    const faculty = await Faculty.create({ name: req.body.name.trim(), rank: req.body.rank || '', department: req.body.department || '', load: req.body.load || '' });
    await audit(req, 'faculty.created', String(faculty._id), { name: faculty.name });
    res.status(201).json({ faculty });
  } catch (error) { next(error); }
});

app.get('/api/principal/broadcasts', requireAuth('principal', 'teacher', 'registrar'), async (req, res) => {
  res.json({ broadcasts: await Broadcast.find().populate('author', 'name').sort({ createdAt: -1 }).limit(100).lean() });
});

app.post('/api/principal/broadcasts', requireAuth('principal'), async (req, res, next) => {
  try {
    requireFields(req.body, ['type', 'message']);
    const broadcast = await Broadcast.create({ type: req.body.type, message: req.body.message.trim(), sms: Boolean(req.body.sms), author: req.session.account.id });
    await audit(req, 'broadcast.created', String(broadcast._id), { type: broadcast.type });
    res.status(201).json({ broadcast });
  } catch (error) { next(error); }
});

app.get('/api/principal/audit', requireAuth('principal'), async (req, res) => {
  res.json({ events: await AuditEvent.find().populate('actor', 'name identifier role').sort({ createdAt: -1 }).limit(500).lean() });
});

app.post('/api/auth/recovery/start', async (req, res, next) => {
  try {
    requireFields(req.body, ['identifier', 'role']);
    if (!roles.includes(req.body.role)) throw httpError(400, 'Select a valid account type.');
    if (req.body.channel !== 'email') throw httpError(400, 'Email is the only configured recovery method.');
    if (process.env.NODE_ENV === 'production' && (!process.env.SMTP_HOST || !process.env.MAIL_FROM)) {
      throw httpError(503, 'Account recovery email is not configured. Contact the school administrator.');
    }
    const eligibility = req.body.role === 'student'
      ? { $or: [{ registrationStatus: 'Approved' }, { registrationStatus: { $exists: false } }] }
      : {};
    const account = await Account.findOne({
      role: req.body.role,
      identifier: req.body.identifier.trim().toLowerCase(),
      active: true,
      ...eligibility
    });
    const response = {
      message: 'If the account is eligible, a verification code has been sent to its registered email address.',
      challengeId: crypto.randomBytes(12).toString('hex')
    };
    if (account && (account.email || process.env.NODE_ENV !== 'production')) {
      await RecoveryChallenge.deleteMany({ account: account._id });
      const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const challenge = await RecoveryChallenge.create({
        account: account._id,
        otpHash: crypto.createHash('sha256').update(otp).digest('hex'),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      });
      response.challengeId = String(challenge._id);
      if (process.env.SMTP_HOST && process.env.MAIL_FROM && account.email) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined
        });
        try {
          await transporter.sendMail({
            from: process.env.MAIL_FROM,
            to: account.email,
            subject: 'NMHS SERMS account recovery',
            text: `Your verification code is ${otp}. It expires in 10 minutes. If you did not request this code, ignore this email.`
          });
        } catch (error) {
          await challenge.deleteOne();
          console.error('Recovery email delivery failed:', error);
          throw httpError(503, 'Recovery email delivery is temporarily unavailable. Please try again later.');
        }
      } else {
        response.developmentCode = otp;
      }
    }
    res.status(202).json(response);
  } catch (error) { next(error); }
});

app.post('/api/auth/recovery/verify', async (req, res, next) => {
  try {
    requireFields(req.body, ['challengeId', 'code']);
    if (!mongoose.isValidObjectId(req.body.challengeId) || !/^\d{6}$/.test(req.body.code)) {
      throw httpError(400, 'The code has expired or is no longer valid.');
    }
    const challenge = await RecoveryChallenge.findById(req.body.challengeId);
    if (!challenge || challenge.expiresAt <= new Date() || challenge.verified || challenge.attempts >= 5) throw httpError(400, 'The code has expired or is no longer valid.');
    const account = await Account.findById(challenge.account).select('role active registrationStatus');
    if (!accountCanRecover(account)) throw httpError(400, 'The account is no longer eligible for self-service recovery.');
    const candidate = crypto.createHash('sha256').update(req.body.code.trim()).digest('hex');
    if (candidate !== challenge.otpHash) {
      challenge.attempts += 1;
      await challenge.save();
      throw httpError(400, 'The verification code is incorrect.');
    }
    const resetToken = crypto.randomBytes(32).toString('hex');
    challenge.verified = true;
    challenge.resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    challenge.expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await challenge.save();
    res.json({ resetToken });
  } catch (error) { next(error); }
});

app.post('/api/auth/recovery/reset', async (req, res, next) => {
  try {
    requireFields(req.body, ['challengeId', 'resetToken', 'password']);
    if (!mongoose.isValidObjectId(req.body.challengeId) || !/^[a-f\d]{64}$/i.test(req.body.resetToken)) {
      throw httpError(400, 'The password reset session has expired. Start account recovery again.');
    }
    if (req.body.password.length > 128) throw httpError(400, 'Password must be 128 characters or fewer.');
    if (req.body.password.length < 8 || !/[a-z]/.test(req.body.password) || !/[A-Z]/.test(req.body.password) || !/[0-9]/.test(req.body.password) || !/[^A-Za-z0-9]/.test(req.body.password)) {
      throw httpError(400, 'Use at least 8 characters, including upper- and lowercase letters, a number, and a symbol.');
    }
    const challenge = await RecoveryChallenge.findById(req.body.challengeId);
    const tokenHash = crypto.createHash('sha256').update(req.body.resetToken).digest('hex');
    if (!challenge || !challenge.verified || challenge.expiresAt <= new Date() || challenge.resetTokenHash !== tokenHash) throw httpError(400, 'The password reset session has expired. Start account recovery again.');
    const account = await Account.findById(challenge.account);
    if (!accountCanRecover(account)) throw httpError(400, 'The account is no longer eligible for self-service recovery.');
    account.passwordHash = await bcrypt.hash(req.body.password, 12);
    await account.save();
    await RecoveryChallenge.deleteMany({ account: account._id });
    res.json({ message: 'Password updated successfully.' });
  } catch (error) { next(error); }
});

app.post('/api/helpdesk', publicSubmissionLimiter, async (req, res, next) => {
  try {
    requireFields(req.body, ['name', 'reason']);
    const ticket = await HelpdeskTicket.create({
      name: req.body.name.trim(), identifier: req.body.identifier || '', department: req.body.department || '',
      contact: req.body.contact || '', reason: req.body.reason.trim()
    });
    res.status(201).json({ ticket: { id: ticket._id, status: ticket.status } });
  } catch (error) { next(error); }
});

app.get('/api/helpdesk', requireAuth('registrar', 'principal'), async (req, res) => {
  const tickets = await HelpdeskTicket.find()
    .select('name identifier department contact reason status createdAt')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  res.json({ tickets });
});

app.patch('/api/helpdesk/:id/status', requireAuth('registrar', 'principal'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(400, 'Invalid helpdesk ticket identifier.');
    if (!['Open', 'In Progress', 'Resolved'].includes(req.body.status)) throw httpError(400, 'Invalid helpdesk ticket status.');
    const ticket = await HelpdeskTicket.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true, runValidators: true });
    if (!ticket) throw httpError(404, 'Helpdesk ticket not found.');
    await audit(req, 'helpdesk.status.updated', String(ticket._id), { status: ticket.status });
    res.json({ ticket: { id: ticket._id, status: ticket.status } });
  } catch (error) { next(error); }
});

const pages = new Set([
  'naujan_mhs_student_dashboard.html',
  'naujan_mhs_student_registration.html',
  'nmhs_teacher_portal_dashboard.html',
  'naujan_mhs_registrar_dashboard.html',
  'naujan_mhs_principal_super_admin_dashboard.html',
  'naujan_mhs_official_public_portal.html',
  'naujan_mhs_enrollment_records_management_system.html',
  'naujan_mhs_account_recovery_portal.html'
]);
const protectedPages = new Map([
  ['naujan_mhs_student_dashboard.html', 'student'],
  ['nmhs_teacher_portal_dashboard.html', 'teacher'],
  ['naujan_mhs_registrar_dashboard.html', 'registrar'],
  ['naujan_mhs_principal_super_admin_dashboard.html', 'principal'],
  ['naujan_mhs_enrollment_records_management_system.html', ['registrar', 'principal']]
]);
const pageForRole = {
  student: 'naujan_mhs_student_dashboard.html',
  teacher: 'nmhs_teacher_portal_dashboard.html',
  registrar: 'naujan_mhs_registrar_dashboard.html',
  principal: 'naujan_mhs_principal_super_admin_dashboard.html'
};
app.use('/assets', express.static(path.join(__dirname, 'public'), { index: false }));
app.get(['/', '/landing_page.html'], (req, res) => res.sendFile(path.join(__dirname, 'naujan_mhs_official_public_portal.html')));
app.get('/:page', (req, res, next) => {
  if (!pages.has(req.params.page)) return next();
  const requiredRole = protectedPages.get(req.params.page);
  if (requiredRole) {
    const account = req.session.account;
    if (!account) return res.redirect(`/?signin=${encodeURIComponent(Array.isArray(requiredRole) ? requiredRole[0] : requiredRole)}`);
    const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (!allowed.includes(account.role)) return res.redirect(`/${pageForRole[account.role] || pageForRole.student}`);
  }
  res.sendFile(path.join(__dirname, req.params.page));
});

app.use('/api', (req, res, next) => next(httpError(404, 'API endpoint not found.')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.name === 'ValidationError') return res.status(400).json({ error: error.message });
  if (error.name === 'CastError') return res.status(400).json({ error: 'Invalid record identifier.' });
  const status = error.status || (error.code === 11000 ? 409 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'The server could not complete the request.' : error.message });
});

async function start() {
  if (!mongoUri) throw new Error('MONGODB_URI is required in production. Set it to your MongoDB connection string.');
  if (!process.env.MONGODB_URI && process.env.NODE_ENV !== 'production') {
    console.log('MONGODB_URI is not set; using local MongoDB at mongodb://127.0.0.1:27017/naujan_mhs_serms');
  }
  if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
  }
  await mongoose.connect(mongoUri);
  for (const [model, legacyKeys] of [
    [Attendance, ['teacher', 'date']],
    [GradeSubmission, ['teacher', 'quarter', 'section']]
  ]) {
    try {
      await model.createCollection();
    } catch (error) {
      if (error.codeName !== 'NamespaceExists') throw error;
    }
    const indexes = await model.collection.indexes();
    const obsolete = indexes.find(index =>
      index.unique && JSON.stringify(Object.keys(index.key)) === JSON.stringify(legacyKeys)
    );
    if (obsolete) await model.collection.dropIndex(obsolete.name);
    await model.init();
  }
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`NMHS SERMS is running at http://localhost:${port}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = app;
