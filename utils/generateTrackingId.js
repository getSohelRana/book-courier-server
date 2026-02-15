const generateTrackingId = () => {
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  const timestamp = Date.now().toString().slice(-6);

  return `TRK-${timestamp}-${random}`;
};

module.exports = generateTrackingId;
