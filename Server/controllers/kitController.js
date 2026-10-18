import Kit from "../models/Kit.js";

// Browse all available Kit Bundles (with filters: School, Gender, Class, Tag)
export const getKits = async (req, res) => {
  try {
    const { schoolName, gender, classGrade, badgeTag, search, sellerId } = req.query;
    const filter = {
      status: { $nin: ["deleted", "inactive"] },
      isDeleted: { $ne: true },
      approvalStatus: { $in: ["Approved", "approved"] },
      isApproved: { $ne: false }
    };

    const andConditions = [];

    if (schoolName && schoolName.trim()) {
      const schStr = schoolName.trim();
      const isAllReq = ["all", "all schools", "any", "any school", "general"].includes(schStr.toLowerCase());
      if (!isAllReq) {
        andConditions.push({
          $or: [
            { schoolName: { $regex: schStr, $options: "i" } },
            { schoolName: { $regex: "all school|open for all|general", $options: "i" } },
            { schoolCode: { $in: ["ALL", "GEN", "ALL-SCHOOLS"] } }
          ]
        });
      }
    }

    if (gender && gender !== "All") {
      andConditions.push({
        $or: [
          { gender: gender },
          { gender: { $in: ["Unisex", "All"] } }
        ]
      });
    }

    if (classGrade && classGrade.trim()) {
      const clsStr = classGrade.trim();
      const isAllCls = ["all", "all classes", "all grades", "any class"].includes(clsStr.toLowerCase());
      if (!isAllCls) {
        andConditions.push({
          $or: [
            { classGrade: { $regex: clsStr, $options: "i" } },
            { classGrade: { $regex: "all class|all grade|all", $options: "i" } }
          ]
        });
      }
    }

    if (badgeTag) filter.badgeTag = badgeTag;
    if (sellerId) filter.sellerId = sellerId;

    if (search && search.trim()) {
      const q = search.trim();
      andConditions.push({
        $or: [
          { title: { $regex: q, $options: "i" } },
          { schoolName: { $regex: q, $options: "i" } },
          { description: { $regex: q, $options: "i" } },
          { "items.name": { $regex: q, $options: "i" } }
        ]
      });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    const kits = await Kit.find(filter)
      .populate("sellerId", "storeName name city phone")
      .sort({ createdAt: -1 });

    res.json({
      count: kits.length,
      kits
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch kits", error: error.message });
  }
};

// Get single Kit Bundle details by ID
export const getKitById = async (req, res) => {
  try {
    const kit = await Kit.findOne({
      _id: req.params.id,
      isDeleted: { $ne: true },
      status: { $nin: ["deleted", "inactive"] },
      approvalStatus: { $in: ["Approved", "approved"] },
      isApproved: { $ne: false }
    })
      .populate("sellerId", "storeName name city phone location")
      .populate("items.productId", "name price images category");

    if (!kit) {
      return res.status(404).json({ message: "Kit bundle not found or is awaiting approval" });
    }

    res.json(kit);
  } catch (error) {
    res.status(404).json({ message: "Kit bundle not found or is awaiting approval", error: error.message });
  }
};
