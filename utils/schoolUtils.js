// Backend school utilities for normalizing school names

const schoolDisplayNames = {
  PLAYGROUND: 'Playground School',
  ALHAADIACADEMY: 'Al Haadi Academy',
  // add more enum’name mappings here as needed
};

/**
 * Convert a School enum value into its user-friendly display name.
 * Falls back to capitalizing and spacing the raw enum if no mapping exists.
 */
function getSchoolName(raw) {
  if (schoolDisplayNames[raw]) {
    return schoolDisplayNames[raw];
  }
  // fallback: e.g. "MY_SCHOOL_ENUM" ’ "My School Enum"
  return raw
    .toLowerCase()
    .split(/[_\s]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

module.exports = {
  schoolDisplayNames,
  getSchoolName
};