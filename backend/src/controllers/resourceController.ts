import { Request, Response } from "express";
import Resource from "../models/Resource";
import asyncHandler from "../utils/asyncHandler";
import Vote from "../models/Vote";
import User from "../models/User";
import { AuthRequest } from "../types/AuthRequest";
import { generateResources } from "../utils/perplexity";
import Topic from "../models/Topic";
import redisClient from "../config/redisConfig";

// Add a new resource
export const addResource = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const {
      type,
      url,
      classification,
      comprehensiveness,
      skillLevel,
      topicId,
    } = req.body;

    // Validate input fields
    if (
      !type ||
      !url ||
      !classification ||
      typeof comprehensiveness !== "number" ||
      !skillLevel ||
      !topicId
    ) {
      return res
        .status(400)
        .json({ message: "All fields are required and must be valid" });
    }

    try {
      // Create new resource and associate with creator
      const resource = new Resource({
        type,
        url,
        classification,
        comprehensiveness,
        skillLevel,
        topic: topicId,
        creator: req.user?._id,
      });

      await resource.save();

      // Add manually made resources to Topic's resources array
      const updatedTopic = await Topic.findByIdAndUpdate(
        topicId,
        { $push: { resources: resource._id } },
        { new: true }
      );

      // Refresh cache
      const slug = updatedTopic?.slug;
      await redisClient.del([`topic/${slug}`]);

      // Initialize Vote document for the new resource
      const vote = new Vote({
        resource: resource._id,
        upvoters: [],
        downvoters: [],
      });

      await vote.save();

      // Add resource to the user's resources array
      await User.findByIdAndUpdate(req.user?._id, {
        $push: { resources: resource._id },
      });

      // Fetch the Vote document to get upvote/downvote counts
      const voteDoc = await Vote.findOne({ resource: resource._id });

      // Respond with the resource data including vote counts and flags
      res.status(201).json({
        ...resource.toObject(),
        upvotes: voteDoc?.upvoters.length || 0,
        downvotes: voteDoc?.downvoters.length || 0,
        hasUpvoted: false, // Initialize as not upvoted by the creator
        hasDownvoted: false, // Initialize as not downvoted by the creator
        isBookmarked: false, // Initialize as not bookmarked by the creator
      });
    } catch (error) {
      console.error("Error adding resource:", error);
      res.status(500).json({ message: "Server error while adding resource" });
    }
  }
);

// Get all resources with populated topic and creator
export const getResources = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const resources = await Resource.find()
        .populate("topic")
        .populate("creator", "username email"); // Populate creator's username and email

      // Include vote counts
      const resourcesWithVotes = await Promise.all(
        resources.map(async (resource) => {
          const vote = await Vote.findOne({ resource: resource._id });
          return {
            ...resource.toObject(),
            upvotes: vote?.upvoters.length || 0,
            downvotes: vote?.downvoters.length || 0,
          };
        })
      );

      res.status(200).json(resourcesWithVotes);
    } catch (error) {
      console.error("Error fetching resources:", error);
      res
        .status(500)
        .json({ message: "Server error while fetching resources" });
    }
  }
);

// Upvote a resource
export const upvoteResource = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user?._id;

    try {
      const vote = await Vote.findOne({ resource: id });
      if (!vote) {
        return res
          .status(404)
          .json({ message: "Vote record not found for this resource" });
      }

      // Prevent duplicate upvotes
      if (vote.upvoters.includes(userId as any)) {
        return res
          .status(400)
          .json({ message: "You have already upvoted this resource" });
      }

      // Remove user from downvoters if present
      vote.downvoters = vote.downvoters.filter(
        (uid) => uid.toString() !== userId?.toString()
      );

      // Add user to upvoters
      vote.upvoters.push(userId as any);

      await vote.save();

      res.status(200).json({
        upvotes: vote.upvoters.length,
        downvotes: vote.downvoters.length,
      });
    } catch (error) {
      console.error("Error upvoting resource:", error);
      res.status(500).json({ message: "Server error while upvoting resource" });
    }
  }
);

// Downvote a resource
export const downvoteResource = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user?._id;

    try {
      const vote = await Vote.findOne({ resource: id });
      if (!vote) {
        return res
          .status(404)
          .json({ message: "Vote record not found for this resource" });
      }

      // Prevent duplicate downvotes
      if (vote.downvoters.includes(userId as any)) {
        return res
          .status(400)
          .json({ message: "You have already downvoted this resource" });
      }

      // Remove user from upvoters if present
      vote.upvoters = vote.upvoters.filter(
        (uid) => uid.toString() !== userId?.toString()
      );

      // Add user to downvoters
      vote.downvoters.push(userId as any);

      await vote.save();

      res.status(200).json({
        upvotes: vote.upvoters.length,
        downvotes: vote.downvoters.length,
      });
    } catch (error) {
      console.error("Error downvoting resource:", error);
      res
        .status(500)
        .json({ message: "Server error while downvoting resource" });
    }
  }
);

// Add this new controller function
export const generateResourcesForTopic = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const { topicId } = req.body;

    if (!topicId) {
      return res.status(400).json({ message: "Topic ID is required." });
    }

    try {
      const topic = await Topic.findById(topicId);
      if (!topic) {
        return res.status(404).json({ message: "Topic not found." });
      }

      const resources = await generateResources(topic.name);

      // Save each resource to the database
      const savedResources = await Promise.all(
        resources.map(async (resourceData) => {
          const resource = new Resource({
            ...resourceData,
            topic: topic._id,
            creator: req.user?._id, // Assuming the user is authenticated
          });
          await resource.save();

          // Initialize Vote document for each resource
          const vote = new Vote({
            resource: resource._id,
            upvoters: [],
            downvoters: [],
          });
          await vote.save();

          // Add resource to the topic's resources array
          topic.resources.push(resource._id as any);
          return resource;
        })
      );

      await topic.save();

      redisClient.del([`topic/${topic.slug}`]);

      res.status(201).json(savedResources);
    } catch (error) {
      console.error("Error generating resources:", error);
      res
        .status(500)
        .json({ message: "Server error while generating resources." });
    }
  }
);

// Get upvoters for a resource
export const getUpvoters = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const vote = await Vote.findOne({ resource: id }).populate(
      "upvoters",
      "username avatarUrl"
    );
    if (!vote) {
      return res
        .status(404)
        .json({ message: "Vote record not found for this resource" });
    }

    res.status(200).json(vote.upvoters);
  } catch (error) {
    console.error("Error fetching upvoters:", error);
    res.status(500).json({ message: "Server error while fetching upvoters" });
  }
});

// Get downvoters for a resource
export const getDownvoters = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const vote = await Vote.findOne({ resource: id }).populate(
        "downvoters",
        "username avatarUrl"
      );
      if (!vote) {
        return res
          .status(404)
          .json({ message: "Vote record not found for this resource" });
      }

      res.status(200).json(vote.downvoters);
    } catch (error) {
      console.error("Error fetching downvoters:", error);
      res
        .status(500)
        .json({ message: "Server error while fetching downvoters" });
    }
  }
);
