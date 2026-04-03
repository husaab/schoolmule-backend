// Mock database module - replaces config/database.js in unit tests
// Prevents testConnection() from running at module load

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const db = {
  query: jest.fn(),
  connect: jest.fn().mockResolvedValue(mockClient),
  _mockClient: mockClient,
  _reset() {
    this.query.mockReset();
    this.connect.mockReset().mockResolvedValue(mockClient);
    mockClient.query.mockReset();
    mockClient.release.mockReset();
  },
};

module.exports = db;
