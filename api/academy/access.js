const { can } = require('../middleware/policy');

function hasCourseAudience(user, course, jobTitleIds) {
  if (!user || !course) return false;
  if (course.audience === 'all') return true;
  return course.audience === 'job_titles'
    && user.job_title_active === true
    && typeof user.job_title_id === 'string' && user.job_title_id.length > 0
    && Array.isArray(jobTitleIds) && jobTitleIds.includes(user.job_title_id);
}

function canReadCourse(user, course, jobTitleIds, { preview = false } = {}) {
  if (preview === true) return Boolean(course) && can(user, 'manageAcademy');
  return course?.active === true && hasCourseAudience(user, course, jobTitleIds);
}

module.exports = { hasCourseAudience, canReadCourse };
